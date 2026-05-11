import { createPublicClient, formatUnits, http, parseAbiItem, type Address, type Log } from 'viem';
import { getContractConfig } from '@/lib/contracts';
import { getLogsPaginated, withCache } from '@/lib/rpcUtils';

const DEPOSIT_EVENT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'
);
const WITHDRAW_EVENT = parseAbiItem(
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)'
);
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);
const PROFIT_CREDITED_EVENT = parseAbiItem('event ProfitCredited(uint256 amount)');
const HARVEST_EXECUTED_EVENT = parseAbiItem(
  'event HarvestExecuted(address indexed processor, uint256 indexed nonce, uint256 profitCredited)'
);
const HARVEST_AND_COMPOUNDED_EVENT = parseAbiItem(
  'event HarvestAndCompounded(uint256 rewardClaimed, uint256 rewardSwappedToAsset, uint256 lpAdded, uint256 profitUsdc, uint256 timestamp)'
);
const PROFIT_PULLED_EVENT = parseAbiItem('event ProfitPulled(address indexed to, uint256 amount)');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type AuditTimelineEvent = {
  kind: 'deposit' | 'withdraw' | 'fee_mint' | 'profit_credited';
  timestamp: number;
  blockNumber: string;
  logIndex: number;
  txHash: string;
  owner?: Address;
  assetsUsd?: number;
  shares?: string;
  amountUsd?: number;
  userAmountUsd?: number;
};

export type HarvestProofEvent = {
  timestamp: number;
  blockNumber: string;
  txHash: string;
  profitCreditedUsd: number;
  rewardClaimedAero?: string;
  profitUsdc?: number;
  lpAdded?: string;
  profitPulledUsd?: number;
};

export type OnchainAudit = {
  userAddress: Address;
  chainId: number;
  keeper: Address;
  autocompounder: Address;
  principalUsd: number;
  totalProfitCreditedUsd: number;
  userProfitCreditedUsd: number;
  userShares: string;
  totalShares: string;
  harvests: HarvestProofEvent[];
  timeline: AuditTimelineEvent[];
};

function isAddress(value: string): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

async function getBlockTimestamp(client: ReturnType<typeof createPublicClient>, blockNumber: bigint): Promise<number> {
  const block = await client.getBlock({ blockNumber });
  return Number(block.timestamp);
}

function toUsd(value: bigint): number {
  return Number(formatUnits(value, 6));
}

function logKey(log: Pick<Log, 'transactionHash' | 'logIndex'>): string {
  return `${log.transactionHash}:${log.logIndex}`;
}

export async function loadOnchainAudit(userAddress: string, chainId: number): Promise<OnchainAudit | null> {
  if (!isAddress(userAddress)) return null;
  const cacheKey = `onchain-audit:${userAddress.toLowerCase()}:${chainId}`;
  return withCache(cacheKey, () => _fetchOnchainAudit(userAddress, chainId), 3 * 60 * 1_000);
}

async function _fetchOnchainAudit(userAddress: string, chainId: number): Promise<OnchainAudit | null> {
  if (!isAddress(userAddress)) return null;

  const config = getContractConfig(chainId);
  if (!isAddress(config.keeper) || !isAddress(config.autocompounder) || !config.rpc) return null;

  const client = createPublicClient({ transport: http(config.rpc) });
  const fromBlock = config.deploymentBlock ?? BigInt(0);

  // Cast to any[] — getLogsPaginated returns generic Log[], but we know the
  // shape from the event ABI. Using any here avoids ~30 TS errors on .args.
  const [depositLogs, withdrawLogs, transferLogs, profitLogs, harvestLogs, compoundLogs, pulledLogs] =
    (await Promise.all([
      getLogsPaginated(client as any, { address: config.keeper, event: DEPOSIT_EVENT, fromBlock }),
      getLogsPaginated(client as any, { address: config.keeper, event: WITHDRAW_EVENT, fromBlock }),
      getLogsPaginated(client as any, { address: config.keeper, event: TRANSFER_EVENT, fromBlock }),
      getLogsPaginated(client as any, { address: config.keeper, event: PROFIT_CREDITED_EVENT, fromBlock }),
      getLogsPaginated(client as any, { address: config.keeper, event: HARVEST_EXECUTED_EVENT, fromBlock }),
      getLogsPaginated(client as any, { address: config.autocompounder, event: HARVEST_AND_COMPOUNDED_EVENT, fromBlock }),
      getLogsPaginated(client as any, { address: config.autocompounder, event: PROFIT_PULLED_EVENT, fromBlock }),
    ])) as [any[], any[], any[], any[], any[], any[], any[]];

  const blockNumbers = Array.from(
    new Set(
      [...depositLogs, ...withdrawLogs, ...transferLogs, ...profitLogs, ...harvestLogs, ...compoundLogs, ...pulledLogs]
        .map((log) => log.blockNumber as bigint | null)
        .filter((bn): bn is bigint => bn != null)
    )
  );
  const timestampEntries = await Promise.all(
    blockNumbers.map(async (blockNumber) => [blockNumber, await getBlockTimestamp(client, blockNumber)] as const)
  );
  const timestamps = new Map<bigint, number>(timestampEntries);

  const depositTxs = new Set(depositLogs.map((log) => log.transactionHash as string));
  const userLower = userAddress.toLowerCase();

  const timeline: AuditTimelineEvent[] = [
    ...depositLogs.map((log) => ({
      kind: 'deposit' as const,
      timestamp: timestamps.get(log.blockNumber) ?? 0,
      blockNumber: String(log.blockNumber ?? 0),
      logIndex: log.logIndex ?? 0,
      txHash: (log.transactionHash ?? '') as string,
      owner: log.args?.owner as Address,
      assetsUsd: toUsd(log.args?.assets ?? BigInt(0)),
      shares: (log.args?.shares ?? BigInt(0)).toString(),
    })),
    ...withdrawLogs.map((log) => ({
      kind: 'withdraw' as const,
      timestamp: timestamps.get(log.blockNumber) ?? 0,
      blockNumber: String(log.blockNumber ?? 0),
      logIndex: log.logIndex ?? 0,
      txHash: (log.transactionHash ?? '') as string,
      owner: log.args?.owner as Address,
      assetsUsd: toUsd(log.args?.assets ?? BigInt(0)),
      shares: (log.args?.shares ?? BigInt(0)).toString(),
    })),
    ...transferLogs
      .filter((log) => {
        const from = String(log.args?.from ?? '').toLowerCase();
        return from === ZERO_ADDRESS && !depositTxs.has(log.transactionHash);
      })
      .map((log) => ({
        kind: 'fee_mint' as const,
        timestamp: timestamps.get(log.blockNumber) ?? 0,
        blockNumber: String(log.blockNumber ?? 0),
        logIndex: log.logIndex ?? 0,
        txHash: (log.transactionHash ?? '') as string,
        owner: log.args?.to as Address,
        shares: (log.args?.value ?? BigInt(0)).toString(),
      })),
    ...profitLogs.map((log) => ({
      kind: 'profit_credited' as const,
      timestamp: timestamps.get(log.blockNumber) ?? 0,
      blockNumber: String(log.blockNumber ?? 0),
      logIndex: log.logIndex ?? 0,
      txHash: (log.transactionHash ?? '') as string,
      amountUsd: toUsd(log.args?.amount ?? BigInt(0)),
    })),
  ]
    .filter((event) => event.timestamp > 0)
    .sort((a, b) =>
      (a.timestamp - b.timestamp) ||
      (Number(a.blockNumber) - Number(b.blockNumber)) ||
      (a.logIndex - b.logIndex)
    );

  let userShares = 0;
  let totalShares = 0;
  let principalUsd = 0;
  let totalProfitCreditedUsd = 0;
  let userProfitCreditedUsd = 0;

  const enrichedTimeline = timeline.map((event) => {
    if (event.kind === 'deposit') {
      const shares = Number(formatUnits(BigInt(event.shares ?? '0'), 6));
      totalShares += shares;
      if (event.owner?.toLowerCase() === userLower) {
        userShares += shares;
        principalUsd += event.assetsUsd ?? 0;
      }
    } else if (event.kind === 'withdraw') {
      const shares = Number(formatUnits(BigInt(event.shares ?? '0'), 6));
      totalShares = Math.max(0, totalShares - shares);
      if (event.owner?.toLowerCase() === userLower) {
        userShares = Math.max(0, userShares - shares);
        principalUsd = Math.max(0, principalUsd - (event.assetsUsd ?? 0));
      }
    } else if (event.kind === 'fee_mint') {
      totalShares += Number(formatUnits(BigInt(event.shares ?? '0'), 6));
    } else if (event.kind === 'profit_credited') {
      const amount = event.amountUsd ?? 0;
      const userAmount = totalShares > 0 ? amount * Math.min(userShares / totalShares, 1) : 0;
      totalProfitCreditedUsd += amount;
      userProfitCreditedUsd += userAmount;
      return { ...event, userAmountUsd: userAmount };
    }
    return event;
  });

  const compoundByTx = new Map(compoundLogs.map((log) => [log.transactionHash as string, log]));
  const pulledByTx = new Map(pulledLogs.map((log) => [log.transactionHash as string, log]));
  const creditedByTx = new Map(profitLogs.map((log) => [log.transactionHash as string, log]));

  const harvests: HarvestProofEvent[] = harvestLogs.map((log) => {
    const compound = compoundByTx.get(log.transactionHash);
    const pulled = pulledByTx.get(log.transactionHash);
    const credited = creditedByTx.get(log.transactionHash);
    const profitCredited = log.args?.profitCredited ?? credited?.args?.amount ?? BigInt(0);

    return {
      timestamp: timestamps.get(log.blockNumber) ?? 0,
      blockNumber: String(log.blockNumber ?? 0),
      txHash: (log.transactionHash ?? '') as string,
      profitCreditedUsd: toUsd(profitCredited),
      rewardClaimedAero: compound?.args?.rewardClaimed?.toString(),
      profitUsdc: compound?.args?.profitUsdc != null ? toUsd(compound.args.profitUsdc) : undefined,
      lpAdded: compound?.args?.lpAdded?.toString(),
      profitPulledUsd: pulled?.args?.amount != null ? toUsd(pulled.args.amount) : undefined,
    };
  });

  return {
    userAddress,
    chainId,
    keeper: config.keeper,
    autocompounder: config.autocompounder,
    principalUsd,
    totalProfitCreditedUsd,
    userProfitCreditedUsd,
    userShares: Math.round(userShares * 1e6).toString(),
    totalShares: Math.round(totalShares * 1e6).toString(),
    harvests,
    timeline: enrichedTimeline,
  };
}


