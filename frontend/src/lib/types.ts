export interface WorkerState {
  previousApr: number | null;
  apiFailureStreak: number;
  lastDecisionReason: string | null;
  lastRunAt: number | null;
  lastExecutionAt: number | null;
  suggestedNextCheckMs: number;
  yieldIndexerCheckpointBlock: number | null;
  rewardAprEwm: { mean: number; variance: number; lastTimestamp: number } | null;
  gridTradesExecuted?: number;
  lastGridTradeAt?: number | null;
  /** Sum of all confirmed harvest rewardUsd values since inception. */
  totalRealizedProfitUsd?: number;
  /**
   * Net estimated yield currently accruing in the pool (post gas/fee).
   * Derived from the most recent profitability_check netRewardUsd.
   * Reset to 0 on harvest_confirmed.
   */
  unrealizedYieldUsd?: number;
  error?: string;
  defaultState?: boolean;
}
