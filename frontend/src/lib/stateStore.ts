/**
 * Persistent state store using Netlify Blobs.
 * Falls back to in-memory defaults for local development (no Netlify context).
 *
 * Tenant isolation:
 *   All blob keys are scoped to `state_<userAddress>_<chainId>` and
 *   `logs_<userAddress>_<chainId>` when chainId is known. There are no
 *   global/anonymous fallback keys. Every read/write requires a userAddress.
 *   This prevents cross-user state leakage and log poisoning.
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

// Half-life for the reward APR exponential moving average (24 hours in seconds).
// A value observed 24 h ago contributes 50% weight to the current mean.
const EWMA_HALF_LIFE_SEC = 24 * 3600;

/**
 * Compute the EWMA decay factor for a given elapsed time.
 * α = 1 - exp(-dt × ln2 / half_life)
 * When dt → 0, α → 0 (no update). When dt → ∞, α → 1 (full replacement).
 */
function ewmaAlpha(elapsedSec: number): number {
  return 1 - Math.exp((-elapsedSec * Math.LN2) / EWMA_HALF_LIFE_SEC);
}

async function getBlobs() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore('yieldsense-state');
  } catch {
    return null;
  }
}

function normaliseChainId(chainId?: string | number | null): string | null {
  const value = String(chainId ?? '').trim();
  return value.length > 0 ? value : null;
}

function scopedBlobKey(prefix: 'state' | 'logs', userAddress: string, chainId?: string | number | null): string {
  const normalisedUser = userAddress.toLowerCase();
  const normalisedChain = normaliseChainId(chainId);
  return normalisedChain
    ? `${prefix}_${normalisedUser}_${normalisedChain}`
    : `${prefix}_${normalisedUser}`;
}

function eventChainId(event: Record<string, unknown>): string | null {
  return normaliseChainId((event.chainId as string | number | undefined) ?? (event.CHAIN_ID as string | number | undefined));
}

function filterLogsForChain(logs: unknown[], chainId?: string | number | null): unknown[] {
  const normalisedChain = normaliseChainId(chainId);
  if (!normalisedChain) return logs;

  return logs.filter((log: any) => {
    const logChainId = normaliseChainId(log?.chainId ?? log?.CHAIN_ID);
    return !logChainId || logChainId === normalisedChain;
  });
}

// ── Public read API ───────────────────────────────────────────────────────────

export async function getState(userAddress?: string, chainId?: string | number | null): Promise<WorkerState> {
  if (!userAddress) return DEFAULT_STATE;
  const blobs = await getBlobs();
  if (!blobs) return DEFAULT_STATE;
  try {
    const scopedRaw = await blobs.get(scopedBlobKey('state', userAddress, chainId), { type: 'json' });
    if (scopedRaw) return scopedRaw as WorkerState;

    const legacyRaw = chainId
      ? await blobs.get(scopedBlobKey('state', userAddress), { type: 'json' })
      : null;
    return (legacyRaw as WorkerState | null) ?? DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

export async function getLogs(userAddress?: string, chainId?: string | number | null): Promise<unknown[]> {
  if (!userAddress) return [];
  const blobs = await getBlobs();
  if (!blobs) return [];
  try {
    const scopedRaw = await blobs.get(scopedBlobKey('logs', userAddress, chainId), { type: 'json' });
    if (scopedRaw) return scopedRaw as unknown[];

    const legacyRaw = chainId
      ? await blobs.get(scopedBlobKey('logs', userAddress), { type: 'json' })
      : null;
    return filterLogsForChain((legacyRaw as unknown[] | null) ?? [], chainId);
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
 * Atomicity: state and logs are read once at the top, all mutations are
 * computed in memory, then both blobs are written in parallel at the end.
 * This eliminates the stale-read race condition in the previous design where
 * getLogs() was called a second time inside the harvest_confirmed branch.
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
  const chainId = eventChainId(event);
  const stateKey = scopedBlobKey('state', normalised, chainId);
  const logsKey = scopedBlobKey('logs', normalised, chainId);

  const blobs = await getBlobs();

  // Single parallel read — prevents the double-read race condition where a
  // concurrent write between two getLogs() calls could drop an event.
  const [currentState, existingLogs] = await Promise.all([
    getState(normalised, chainId),
    getLogs(normalised, chainId),
  ]);

  const patch: Partial<WorkerState> = {
    lastRunAt: (event.timestamp as number | undefined) ?? Math.floor(Date.now() / 1000),
    defaultState: false,
  };

  switch (event.event as string) {
    case 'profitability_check': {
      patch.previousApr = (event.apr as number | undefined) ?? currentState.previousApr;
      patch.lastDecisionReason = (event.reason as string | undefined) ?? currentState.lastDecisionReason;
      patch.suggestedNextCheckMs =
        (event.recommendedNextCheckMs as number | undefined) ?? currentState.suggestedNextCheckMs;
      patch.apiFailureStreak = 0;

      // Use netRewardUsd (post gas/fee) rather than grossRewardUsd so the
      // displayed "unrealized yield" reflects what the user would actually receive.
      // Fall back to grossRewardUsd only when netRewardUsd is absent (older processors).
      const netReward = (event.netRewardUsd as number | undefined);
      const grossReward = (event.grossRewardUsd as number | undefined);
      patch.unrealizedYieldUsd = (netReward ?? grossReward) ?? currentState.unrealizedYieldUsd;

      // Proper time-decayed EWMA for reward APR.
      // Previous code set variance=0 and replaced mean entirely, which is not an average.
      if (event.rewardApr != null) {
        const newValue = event.rewardApr as number;
        const ts = (event.timestamp as number | undefined) ?? Math.floor(Date.now() / 1000);
        const prev = currentState.rewardAprEwm;

        if (!prev) {
          patch.rewardAprEwm = { mean: newValue, variance: 0, lastTimestamp: ts };
        } else {
          const elapsedSec = Math.max(0, ts - prev.lastTimestamp);
          const alpha = ewmaAlpha(elapsedSec);
          const newMean = alpha * newValue + (1 - alpha) * prev.mean;
          // Welford-style online variance update
          const newVariance = (1 - alpha) * (prev.variance + alpha * Math.pow(newValue - prev.mean, 2));
          patch.rewardAprEwm = { mean: newMean, variance: newVariance, lastTimestamp: ts };
        }
      }
      break;
    }

    case 'harvest_submitted':
      patch.lastDecisionReason = 'executed';
      patch.lastExecutionAt = event.timestamp as number;
      patch.apiFailureStreak = 0;
      break;

    case 'harvest_confirmed': {
      // Deduplication: use the already-read existingLogs — no second getLogs() call.
      const isDuplicate =
        event.txHash &&
        existingLogs.some((l: any) => l.txHash === event.txHash && l.event === 'harvest_confirmed');

      if (isDuplicate) {
        console.warn(`[stateStore] Ignoring duplicate harvest_confirmed for tx: ${event.txHash}`);
        return;
      }

      patch.lastDecisionReason = 'executed';
      patch.lastExecutionAt = event.timestamp as number;
      patch.apiFailureStreak = 0;
      // Harvest realized the accrued yield — reset unrealized and accumulate realized.
      patch.unrealizedYieldUsd = 0;
      // Only accumulate realized profit when the processor provides an amount
      // decoded from keeper events. Legacy rewardUsd was an off-chain estimate
      // and must not be treated as accounting truth.
      if (event.profitCreditedUsd != null) {
        patch.totalRealizedProfitUsd =
          (currentState.totalRealizedProfitUsd ?? 0) + ((event.profitCreditedUsd as number) ?? 0);
      }
      break;
    }

    case 'harvest_skipped_profitability': {
      patch.lastDecisionReason =
        (event.reason as string | undefined) ?? 'harvest_skipped_profitability';
      patch.suggestedNextCheckMs =
        (event.recommendedNextCheckMs as number | undefined) ?? currentState.suggestedNextCheckMs;
      patch.apiFailureStreak = 0;
      patch.unrealizedYieldUsd =
        (event.netRewardUsd as number | undefined) ?? currentState.unrealizedYieldUsd;
      break;
    }

    case 'grid_trade_executed':
      patch.gridTradesExecuted = (currentState.gridTradesExecuted ?? 0) + 1;
      patch.lastGridTradeAt = event.timestamp as number;
      patch.lastDecisionReason = 'grid_trade';
      patch.apiFailureStreak = 0;
      // Note: pnlDelta from the processor is an allocation-scaled indicator
      // (allocationBps / 10000 × 1e6), NOT a USD realized profit figure.
      // It is intentionally not accumulated into totalRealizedProfitUsd here.
      // Once the protocol provides on-chain realized PnL, add it here.
      break;

    case 'yield_not_usable':
      patch.apiFailureStreak = (currentState.apiFailureStreak ?? 0) + 1;
      patch.lastDecisionReason = 'yield_not_usable';
      patch.previousApr = (event.totalApr as number | undefined) ?? currentState.previousApr;
      break;

    case 'runtime_error':
      patch.apiFailureStreak = (currentState.apiFailureStreak ?? 0) + 1;
      patch.lastDecisionReason = 'runtime_error';
      patch.error = (event.message as string | undefined) ?? currentState.error;
      break;

    case 'telemetry_config_error':
      patch.apiFailureStreak = (currentState.apiFailureStreak ?? 0) + 1;
      patch.lastDecisionReason = 'telemetry_config_error';
      patch.error =
        `${event.reason ?? 'unknown'} while emitting ${event.originalEvent ?? 'unknown_event'}`;
      break;

    case 'run_skipped_recent':
      patch.lastDecisionReason = 'cooldown_guard';
      patch.suggestedNextCheckMs =
        (event.intervalMs as number | undefined) ?? currentState.suggestedNextCheckMs;
      break;

    case 'processor_cycle_complete':
      patch.lastDecisionReason =
        (event.lastDecisionReason as string | undefined) ?? currentState.lastDecisionReason;
      patch.suggestedNextCheckMs =
        (event.nextDelayMs as number | undefined) ?? currentState.suggestedNextCheckMs;
      patch.apiFailureStreak =
        (event.apiFailureStreak as number | undefined) ?? currentState.apiFailureStreak;
      break;

    case 'processor_error':
    case 'grid_check_error':
      patch.apiFailureStreak = (currentState.apiFailureStreak ?? 0) + 1;
      patch.lastDecisionReason = event.event as string;
      patch.error = (event.message as string | undefined) ?? currentState.error;
      break;

    case 'force_test_bypass':
      patch.lastDecisionReason = 'force_test_harvest';
      patch.previousApr = (event.totalApr as number | undefined) ?? currentState.previousApr;
      patch.apiFailureStreak = 0;
      break;
  }

  if (!blobs) return;

  const newState: WorkerState = { ...currentState, ...patch };
  // Ring buffer: newest event first, capped at 100 entries.
  const newLogs = [event, ...existingLogs].slice(0, 100);

  // Parallel write — both blobs updated atomically in a single round-trip.
  await Promise.all([
    blobs.setJSON(stateKey, newState),
    blobs.setJSON(logsKey, newLogs),
  ]);
}
