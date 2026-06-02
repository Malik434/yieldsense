export type GridSide = "buy" | "sell";

export type ChainStateSnapshot = {
  strategyVersion: number;
  currentGridLevel: number;
  lastExecutionAt: string;
  quoteBalance: string;
  baseBalance: string;
};

export type ExecutionJobStatus =
  | "pending"
  | "claimed"
  | "stale"
  | "submitted"
  | "confirmed"
  | "reverted"
  | "failed"
  | "expired"
  | "cancelled";

export type ExecutionJob = {
  id: string;
  strategyId: string;
  pairId: string;
  side: GridSide;
  gridLevel: number;
  idempotencyKey: string;
  chainStateSnapshot: ChainStateSnapshot;
  status: ExecutionJobStatus;
  attempts: number;
  createdAt: string;
  claimedAt?: string;
  txHash?: string;
  gasUsed?: string;
  gasCostQuote?: string;
  staleReason?: string;
  revertReason?: string;
  error?: string;
};

export function buildExecutionIdempotencyKey(args: {
  strategyId: string;
  strategyVersion: number;
  pairId: string;
  gridLevel: number;
  side: GridSide;
  intervalWindow: number;
}) {
  return [
    args.strategyId.toLowerCase(),
    String(args.strategyVersion),
    args.pairId.toLowerCase(),
    String(args.gridLevel),
    args.side,
    String(args.intervalWindow),
  ].join(":");
}

export function compareChainStateSnapshot(expected: ChainStateSnapshot, actual: ChainStateSnapshot) {
  const failures: string[] = [];

  if (expected.strategyVersion !== actual.strategyVersion) {
    failures.push(`strategyVersion expected ${expected.strategyVersion}, got ${actual.strategyVersion}`);
  }
  if (expected.currentGridLevel !== actual.currentGridLevel) {
    failures.push(`currentGridLevel expected ${expected.currentGridLevel}, got ${actual.currentGridLevel}`);
  }
  if (expected.lastExecutionAt !== actual.lastExecutionAt) {
    failures.push(`lastExecutionAt expected ${expected.lastExecutionAt}, got ${actual.lastExecutionAt}`);
  }
  if (expected.quoteBalance !== actual.quoteBalance) {
    failures.push(`quoteBalance expected ${expected.quoteBalance}, got ${actual.quoteBalance}`);
  }
  if (expected.baseBalance !== actual.baseBalance) {
    failures.push(`baseBalance expected ${expected.baseBalance}, got ${actual.baseBalance}`);
  }

  return {
    isFresh: failures.length === 0,
    failures,
  };
}

export function assertFreshChainState(expected: ChainStateSnapshot, actual: ChainStateSnapshot) {
  const comparison = compareChainStateSnapshot(expected, actual);
  if (!comparison.isFresh) {
    throw new Error(`Stale grid execution job: ${comparison.failures.join("; ")}`);
  }
}

export function deriveIntervalWindow(timestampMs: number, intervalSeconds: number) {
  const intervalMs = Math.max(1, intervalSeconds) * 1000;
  return Math.floor(timestampMs / intervalMs);
}

export function classifyReceiptStatus(receipt: { status?: number | bigint | null }) {
  if (receipt.status === 1 || receipt.status === 1n) return "confirmed" as const;
  if (receipt.status === 0 || receipt.status === 0n) return "reverted" as const;
  return "submitted" as const;
}
