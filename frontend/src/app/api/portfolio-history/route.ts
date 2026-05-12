import { NextResponse } from 'next/server';
import { createPublicClient, decodeEventLog, formatUnits, http, parseAbiItem, toEventSelector, type Address } from 'viem';
import { getContractConfig } from '@/lib/contracts';
import { getLogsPaginated, withCache } from '@/lib/rpcUtils';

const DEPOSIT_EVENT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'
);
const WITHDRAW_EVENT = parseAbiItem(
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)'
);
const EMPTY_HISTORY = { events: [] };

type PortfolioEvent = {
  type: 'deposit' | 'withdraw';
  owner: Address;
  timestamp: number;
  blockNumber: string;
  txHash: string;
  assetsUsd: number;
  shares: string;
};

type BaseScanLog = {
  blockNumber?: string;
  timeStamp?: string;
  transactionHash?: string;
  data: `0x${string}`;
  topics: [`0x${string}`, ...`0x${string}`[]];
};

type BaseScanResponse = {
  status?: string;
  message?: string;
  result?: BaseScanLog[] | string;
};

function isAddress(value: string): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function parseBlockNumber(value: string | number | bigint | undefined): bigint {
  if (value == null) return BigInt(0);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return value.startsWith('0x') ? BigInt(value) : BigInt(Number(value));
}

function parseTimestamp(value: string | number | undefined): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  return value.startsWith('0x') ? Number(BigInt(value)) : Number(value);
}

function ownerTopic(address: Address): `0x${string}` {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

async function loadEventsFromBaseScan(
  keeper: Address,
  userAddress: Address,
  fromBlock: bigint
): Promise<PortfolioEvent[] | null> {
  const apiKey = process.env.BASESCAN_API_KEY || process.env.NEXT_PUBLIC_BASESCAN_API_KEY;
  if (!apiKey) return null;

  const baseUrl = process.env.BASESCAN_API_URL || 'https://api.basescan.org/api';
  const topicOwner = ownerTopic(userAddress);
  const common = {
    module: 'logs',
    action: 'getLogs',
    fromBlock: fromBlock.toString(),
    toBlock: 'latest',
    address: keeper,
    apikey: apiKey,
  };

  const fetchLogs = async (event: typeof DEPOSIT_EVENT | typeof WITHDRAW_EVENT, topicKey: 'topic2' | 'topic3') => {
    const url = new URL(baseUrl);
    Object.entries({
      ...common,
      topic0: toEventSelector(event),
      [topicKey]: topicOwner,
      topic0_1_opr: 'and',
      topic0_2_opr: 'and',
      topic0_3_opr: 'and',
    }).forEach(([key, value]) => url.searchParams.set(key, String(value)));

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
      if (!res.ok) return null;
      const data = (await res.json()) as BaseScanResponse;
      if (data.status === '0' && data.message !== 'No records found') return null;
      return Array.isArray(data.result) ? data.result : [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[api/portfolio-history] BaseScan ${topicKey} unavailable: ${message}`);
      return null;
    }
  };

  const [depositRaw, withdrawRaw] = await Promise.all([
    fetchLogs(DEPOSIT_EVENT, 'topic2'),
    fetchLogs(WITHDRAW_EVENT, 'topic3'),
  ]);

  if (!depositRaw || !withdrawRaw) return null;

  const deposits: PortfolioEvent[] = depositRaw.map((log) => {
    const decoded = decodeEventLog({
      abi: [DEPOSIT_EVENT],
      data: log.data,
      topics: log.topics,
    });
    const args = decoded.args as { owner: Address; assets: bigint; shares: bigint };
    return {
      type: 'deposit',
      owner: args.owner,
      timestamp: parseTimestamp(log.timeStamp),
      blockNumber: parseBlockNumber(log.blockNumber).toString(),
      txHash: log.transactionHash ?? '',
      assetsUsd: Number(formatUnits(args.assets, 6)),
      shares: args.shares.toString(),
    };
  });

  const withdrawals: PortfolioEvent[] = withdrawRaw.map((log) => {
    const decoded = decodeEventLog({
      abi: [WITHDRAW_EVENT],
      data: log.data,
      topics: log.topics,
    });
    const args = decoded.args as { owner: Address; assets: bigint; shares: bigint };
    return {
      type: 'withdraw',
      owner: args.owner,
      timestamp: parseTimestamp(log.timeStamp),
      blockNumber: parseBlockNumber(log.blockNumber).toString(),
      txHash: log.transactionHash ?? '',
      assetsUsd: Number(formatUnits(args.assets, 6)),
      shares: args.shares.toString(),
    };
  });

  return [...deposits, ...withdrawals]
    .filter((event) => event.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get('userAddress') || '';
    const chainId = Number(searchParams.get('chainId') || '8453');

    if (!isAddress(userAddress)) {
      return NextResponse.json({ events: [] });
    }

    const config = getContractConfig(chainId);
    if (!isAddress(config.keeper) || !config.rpc) {
      return NextResponse.json({ events: [] });
    }

    const client = createPublicClient({
      transport: http(config.rpc),
    });

    const fromBlock = config.deploymentBlock ?? BigInt(0);
    const cacheKey = `portfolio-history:${userAddress.toLowerCase()}:${chainId}`;

    const events = await withCache(cacheKey, async () => {
      const baseScanEvents = chainId === 8453
        ? await loadEventsFromBaseScan(config.keeper, userAddress, fromBlock)
        : null;
      if (baseScanEvents) return baseScanEvents;
      if (chainId === 8453 && process.env.ALLOW_PORTFOLIO_RPC_FALLBACK !== 'true') {
        return [];
      }

      const [depositLogs, withdrawLogs] = await Promise.all([
        getLogsPaginated(client, {
          address: config.keeper,
          event: DEPOSIT_EVENT,
          args: { owner: userAddress },
          fromBlock,
        }),
        getLogsPaginated(client, {
          address: config.keeper,
          event: WITHDRAW_EVENT,
          args: { owner: userAddress },
          fromBlock,
        }),
      ]);

      const blockNumbers = Array.from(
        new Set([...depositLogs, ...withdrawLogs].map((log) => log.blockNumber))
      );
      const blockTimestamps = new Map<bigint, number>();

      await Promise.all(
        blockNumbers
          .filter((bn): bn is bigint => bn != null)
          .map(async (blockNumber) => {
            const block = await client.getBlock({ blockNumber });
            blockTimestamps.set(blockNumber, Number(block.timestamp));
          })
      );

      return [
        ...depositLogs.map((log) => ({
          type: 'deposit' as const,
          owner: log.args?.owner as Address,
          timestamp: blockTimestamps.get(log.blockNumber as bigint) ?? 0,
          blockNumber: (log.blockNumber ?? BigInt(0)).toString(),
          txHash: log.transactionHash ?? '',
          assetsUsd: Number(formatUnits(log.args?.assets ?? BigInt(0), 6)),
          shares: (log.args?.shares ?? BigInt(0)).toString(),
        })),
        ...withdrawLogs.map((log) => ({
          type: 'withdraw' as const,
          owner: log.args?.owner as Address,
          timestamp: blockTimestamps.get(log.blockNumber as bigint) ?? 0,
          blockNumber: (log.blockNumber ?? BigInt(0)).toString(),
          txHash: log.transactionHash ?? '',
          assetsUsd: Number(formatUnits(log.args?.assets ?? BigInt(0), 6)),
          shares: (log.args?.shares ?? BigInt(0)).toString(),
        })),
      ]
        .filter((event) => event.timestamp > 0)
        .sort((a, b) => a.timestamp - b.timestamp);
    }, 3 * 60 * 1_000);

    return NextResponse.json({ events });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[api/portfolio-history] Returning empty history after provider failure: ${message}`);
    return NextResponse.json(EMPTY_HISTORY);
  }
}
