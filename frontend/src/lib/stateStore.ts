/**
 * Persistent state store using Netlify Blobs.
 * Falls back to an in-memory object for local development.
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
  error?: string;
  defaultState?: boolean;
}

const DEFAULT_STATE: WorkerState = {
  previousApr: null,
  apiFailureStreak: 0,
  lastDecisionReason: null,
  lastRunAt: null,
  lastExecutionAt: null,
  suggestedNextCheckMs: 300000,
  yieldIndexerCheckpointBlock: null,
  rewardAprEwm: null,
  defaultState: true,
};

// ── Blob helpers (safe-imported so local dev with no Netlify context still works) ──
async function getBlobs() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore('yieldsense-state');
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────────

export async function getState(): Promise<WorkerState & { logs?: any[] }> {
  const blobs = await getBlobs();
  if (!blobs) return DEFAULT_STATE;
  try {
    const raw = await blobs.get('state', { type: 'json' });
    return raw ?? DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

export async function getLogs(): Promise<any[]> {
  const blobs = await getBlobs();
  if (!blobs) return [];
  try {
    const raw = await blobs.get('logs', { type: 'json' });
    return raw ?? [];
  } catch {
    return [];
  }
}

/**
 * Maps a raw telemetry event from the worker to WorkerState fields
 * and appends the event to the persistent log ring buffer.
 */
export async function applyTelemetryEvent(event: any): Promise<void> {
  const blobs = await getBlobs();

  // ── Update WorkerState fields based on event type ──────────────────────────
  const currentState = await getState();
  const patch: Partial<WorkerState> = {
    lastRunAt: event.timestamp ?? Math.floor(Date.now() / 1000),
    defaultState: false,
  };

  switch (event.event) {
    case 'profitability_check':
      patch.previousApr = event.apr ?? currentState.previousApr;
      patch.lastDecisionReason = event.reason ?? currentState.lastDecisionReason;
      patch.suggestedNextCheckMs = event.recommendedNextCheckMs ?? currentState.suggestedNextCheckMs;
      patch.apiFailureStreak = 0;
      if (event.rewardApr != null) {
        patch.rewardAprEwm = { mean: event.rewardApr, variance: 0, lastTimestamp: event.timestamp };
      }
      break;
    case 'harvest_submitted':
    case 'harvest_confirmed':
      patch.lastDecisionReason = 'executed';
      patch.lastExecutionAt = event.timestamp;
      patch.apiFailureStreak = 0;
      break;
    case 'grid_trade_executed':
      patch.gridTradesExecuted = (currentState.gridTradesExecuted ?? 0) + 1;
      patch.lastGridTradeAt = event.timestamp;
      patch.lastDecisionReason = 'grid_trade';
      patch.apiFailureStreak = 0;
      break;
    case 'yield_not_usable':
      patch.apiFailureStreak = (currentState.apiFailureStreak ?? 0) + 1;
      patch.lastDecisionReason = 'yield_not_usable';
      patch.previousApr = event.totalApr ?? currentState.previousApr;
      break;
    case 'runtime_error':
      patch.apiFailureStreak = (currentState.apiFailureStreak ?? 0) + 1;
      patch.lastDecisionReason = 'runtime_error';
      break;
    case 'force_test_bypass':
      patch.lastDecisionReason = 'force_test_harvest';
      patch.previousApr = event.totalApr ?? currentState.previousApr;
      patch.apiFailureStreak = 0;
      break;
  }

  const newState = { ...currentState, ...patch };

  if (blobs) {
    await blobs.setJSON('state', newState);

    // ── Append to log ring buffer (keep last 50 events) ─────────────────────
    const logs = await getLogs();
    logs.unshift(event); // newest first
    if (logs.length > 50) logs.length = 50;
    await blobs.setJSON('logs', logs);
  }
}
