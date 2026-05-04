/**
 * Persistent state store using Netlify Blobs.
 * Falls back to in-memory defaults for local development (no Netlify context).
 *
 * Tenant isolation:
 *   All blob keys are scoped to `state_<userAddress>` and `logs_<userAddress>`.
 *   There are no global/anonymous fallback keys. Every read/write requires a
 *   userAddress. This prevents cross-user state leakage and log poisoning.
 */

interface WorkerState {
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
  totalRealizedProfitUsd?: number;
  unrealizedYieldUsd?: number;
  error?: string;
  defaultState?: boolean;
}

const DEFAULT_STATE: WorkerState = {
  previousApr: null,
  apiFailureStreak: 0,
  lastDecisionReason: null,
  lastRunAt: null,
  lastExecutionAt: null,
  suggestedNextCheckMs: 300_000,
  yieldIndexerCheckpointBlock: null,
  rewardAprEwm: null,
  defaultState: true,
};

async function getBlobs() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore('yieldsense-state');
  } catch {
    return null;
  }
}

// ── Public read API ───────────────────────────────────────────────────────────

export async function getState(userAddress?: string): Promise<WorkerState> {
  if (!userAddress) return DEFAULT_STATE;
  const blobs = await getBlobs();
  if (!blobs) return DEFAULT_STATE;
  try {
    const raw = await blobs.get(`state_${userAddress.toLowerCase()}`, { type: 'json' });
    return (raw as WorkerState | null) ?? DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

export async function getLogs(userAddress?: string): Promise<unknown[]> {
  if (!userAddress) return [];
  const blobs = await getBlobs();
  if (!blobs) return [];
  try {
    const raw = await blobs.get(`logs_${userAddress.toLowerCase()}`, { type: 'json' });
    return (raw as unknown[] | null) ?? [];
  } catch {
    return [];
  }
}

// ── Write API (used only from /api/telemetry after authentication) ────────────

/**
 * Maps a raw telemetry event to WorkerState fields and appends it to the
 * per-user log ring buffer.
 *
 * IMPORTANT: This function must only be called from /api/telemetry AFTER
 * bearer-token authentication. It performs no auth checks itself.
 *
 * @throws if userAddress is missing (prevents anonymous writes)
 */
export async function applyTelemetryEvent(event: Record<string, unknown>): Promise<void> {
  const userAddress =
    (event.userAddress as string | undefined) ||
    (event.USER_ADDRESS as string | undefined);

  if (!userAddress) {
    throw new Error('applyTelemetryEvent: userAddress is required — anonymous writes are not allowed');
  }

  const normalised = userAddress.toLowerCase();
  const stateKey = `state_${normalised}`;
  const logsKey = `logs_${normalised}`;

  const blobs = await getBlobs();
  const currentState = await getState(normalised);

  const patch: Partial<WorkerState> = {
    lastRunAt: (event.timestamp as number | undefined) ?? Math.floor(Date.now() / 1000),
    defaultState: false,
  };

  switch (event.event as string) {
    case 'profitability_check':
      patch.previousApr = (event.apr as number | undefined) ?? currentState.previousApr;
      patch.lastDecisionReason = (event.reason as string | undefined) ?? currentState.lastDecisionReason;
      patch.suggestedNextCheckMs =
        (event.recommendedNextCheckMs as number | undefined) ?? currentState.suggestedNextCheckMs;
      patch.apiFailureStreak = 0;
      patch.unrealizedYieldUsd = (event.grossRewardUsd as number | undefined) ?? currentState.unrealizedYieldUsd;
      if (event.rewardApr != null) {
        patch.rewardAprEwm = {
          mean: event.rewardApr as number,
          variance: 0,
          lastTimestamp: event.timestamp as number,
        };
      }
      break;

    case 'harvest_submitted':
      patch.lastDecisionReason = 'executed';
      patch.lastExecutionAt = event.timestamp as number;
      patch.apiFailureStreak = 0;
      break;

    case 'harvest_confirmed':
      patch.lastDecisionReason = 'executed';
      patch.lastExecutionAt = event.timestamp as number;
      patch.apiFailureStreak = 0;
      // Realized the yield, so reset unrealized to 0 and add to realized total
      patch.unrealizedYieldUsd = 0;
      patch.totalRealizedProfitUsd = (currentState.totalRealizedProfitUsd ?? 0) + ((event.rewardUsd as number) ?? 0);
      break;

    case 'grid_trade_executed':
      patch.gridTradesExecuted = (currentState.gridTradesExecuted ?? 0) + 1;
      patch.lastGridTradeAt = event.timestamp as number;
      patch.lastDecisionReason = 'grid_trade';
      patch.apiFailureStreak = 0;
      break;

    case 'yield_not_usable':
      patch.apiFailureStreak = (currentState.apiFailureStreak ?? 0) + 1;
      patch.lastDecisionReason = 'yield_not_usable';
      patch.previousApr = (event.totalApr as number | undefined) ?? currentState.previousApr;
      break;

    case 'runtime_error':
      patch.apiFailureStreak = (currentState.apiFailureStreak ?? 0) + 1;
      patch.lastDecisionReason = 'runtime_error';
      break;

    case 'force_test_bypass':
      patch.lastDecisionReason = 'force_test_harvest';
      patch.previousApr = (event.totalApr as number | undefined) ?? currentState.previousApr;
      patch.apiFailureStreak = 0;
      break;
  }

  const newState: WorkerState = { ...currentState, ...patch };

  if (blobs) {
    await blobs.setJSON(stateKey, newState);

    // Append to ring buffer (newest first, capped at 50)
    const logs = await getLogs(normalised);
    logs.unshift(event);
    if (logs.length > 50) logs.length = 50;
    await blobs.setJSON(logsKey, logs);
  }
}
