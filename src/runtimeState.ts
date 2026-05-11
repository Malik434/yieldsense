import { promises as fs } from "fs";
import { getAcurastStd, storageGet, storageSet } from "./acurastHardware.js";

export interface WorkerState {
  previousApr: number | null;
  apiFailureStreak: number;
  lastDecisionReason: string | null;
  lastRunAt: number | null;
  lastExecutionAt: number | null;
  suggestedNextCheckMs: number | null;
  lastSkippedAt?: number | null;
  /** Last block through which fee logs were processed successfully */
  yieldIndexerCheckpointBlock?: number | null;
  /** EWMA state for reward APR smoothing */
  rewardAprEwm?: number | null;
  /** Grid keeper stats */
  gridTradesExecuted?: number;
  lastGridTradeAt?: number | null;
  /** Hardware execution logs */
  hardwareLogs?: HardwareLog[];
}

export interface HardwareLog {
  timestamp: number;
  type: 'ATTESTATION' | 'EXECUTION' | 'STORAGE_SYNC';
  message: string;
  txHash?: string;
}

export const defaultState: WorkerState = {
  previousApr: null,
  apiFailureStreak: 0,
  lastDecisionReason: null,
  lastRunAt: null,
  lastExecutionAt: null,
  suggestedNextCheckMs: null,
  yieldIndexerCheckpointBlock: null,
  rewardAprEwm: null,
  gridTradesExecuted: 0,
  lastGridTradeAt: null,
  hardwareLogs: [],
};

function storageKey(path: string): string {
  const namespace =
    process.env.STATE_NAMESPACE?.trim() ||
    process.env.USER_ADDRESS?.trim().toLowerCase() ||
    "default";
  return `worker-state:${namespace}:${path}`;
}

function normalizeState(state: Partial<WorkerState>): WorkerState {
  const rewardAprEwm = state.rewardAprEwm as
    | number
    | {
        mean: number;
        variance?: number;
        lastTimestamp?: number;
      }
    | null
    | undefined;
  const normalizedRewardAprEwm =
    typeof rewardAprEwm === "number"
      ? rewardAprEwm
      : rewardAprEwm && typeof rewardAprEwm === "object" && Number.isFinite(rewardAprEwm.mean)
        ? rewardAprEwm.mean
        : rewardAprEwm ?? defaultState.rewardAprEwm;

  return {
    ...defaultState,
    ...state,
    rewardAprEwm: (normalizedRewardAprEwm as number | null | undefined) ?? defaultState.rewardAprEwm,
  };
}

export async function loadState(path: string): Promise<WorkerState> {
  const std = getAcurastStd();
  if (std?.storage) {
    return normalizeState(storageGet<Partial<WorkerState>>(std, storageKey(path), defaultState));
  }

  try {
    const raw = await fs.readFile(path, "utf8");
    return normalizeState(JSON.parse(raw) as Partial<WorkerState>);
  } catch {
    return { ...defaultState };
  }
}

export async function saveState(path: string, state: WorkerState): Promise<void> {
  const std = getAcurastStd();
  if (std?.storage) {
    storageSet(std, storageKey(path), state);
    return;
  }

  await fs.writeFile(path, JSON.stringify(state, null, 2), "utf8");
}
