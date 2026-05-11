import { NextResponse } from 'next/server';
import { createPublicClient, formatUnits, http, parseAbiItem, type Address } from 'viem';
import { getContractConfig } from '@/lib/contracts';

const DEPOSIT_EVENT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'
);
const WITHDRAW_EVENT = parseAbiItem(
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)'
);

type PortfolioEvent = {
  type: 'deposit' | 'withdraw';
  owner: Address;
  timestamp: number;
  blockNumber: string;
  txHash: string;
  assetsUsd: number;
  shares: string;
};

function isAddress(value: string): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
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

    const [depositLogs, withdrawLogs] = await Promise.all([
      client.getLogs({
        address: config.keeper,
        event: DEPOSIT_EVENT,
        fromBlock,
        toBlock: 'latest',
      }),
      client.getLogs({
        address: config.keeper,
        event: WITHDRAW_EVENT,
        fromBlock,
        toBlock: 'latest',
      }),
    ]);

    const blockNumbers = Array.from(
      new Set([...depositLogs, ...withdrawLogs].map((log) => log.blockNumber))
    );
    const blockTimestamps = new Map<bigint, number>();

    await Promise.all(
      blockNumbers.map(async (blockNumber) => {
        const block = await client.getBlock({ blockNumber });
        blockTimestamps.set(blockNumber, Number(block.timestamp));
      })
    );

    const events: PortfolioEvent[] = [
      ...depositLogs.map((log) => ({
        type: 'deposit' as const,
        owner: log.args.owner as Address,
        timestamp: blockTimestamps.get(log.blockNumber) ?? 0,
        blockNumber: log.blockNumber.toString(),
        txHash: log.transactionHash,
        assetsUsd: Number(formatUnits(log.args.assets ?? BigInt(0), 6)),
        shares: (log.args.shares ?? BigInt(0)).toString(),
      })),
      ...withdrawLogs.map((log) => ({
        type: 'withdraw' as const,
        owner: log.args.owner as Address,
        timestamp: blockTimestamps.get(log.blockNumber) ?? 0,
        blockNumber: log.blockNumber.toString(),
        txHash: log.transactionHash,
        assetsUsd: Number(formatUnits(log.args.assets ?? BigInt(0), 6)),
        shares: (log.args.shares ?? BigInt(0)).toString(),
      })),
    ]
      .filter((event) => event.timestamp > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    return NextResponse.json({ events });
  } catch (error: any) {
    console.error('[api/portfolio-history] Failed to load portfolio history:', error);
    return NextResponse.json(
      { events: [], error: 'Failed to load portfolio history' },
      { status: 500 }
    );
  }
}
