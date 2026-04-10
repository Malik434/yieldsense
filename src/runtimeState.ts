import { promises as fs } from "fs";

export interface WorkerState {
  previousApr: number | null;
  apiFailureStreak: number;
  lastDecisionReason: string | null;
  lastRunAt: number | null;
  lastExecutionAt: number | null;
  suggestedNextCheckMs: number | null;
  /** Last block through which fee logs were processed successfully */
  yieldIndexerCheckpointBlock?: number | null;
  /** EWMA state for reward APR smoothing */
  rewardAprEwm?: number | null;
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
};

export async function loadState(path: string): Promise<WorkerState> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return { ...defaultState, ...(JSON.parse(raw) as Partial<WorkerState>) };
  } catch {
    return { ...defaultState };
  }
}

export async function saveState(path: string, state: WorkerState): Promise<void> {
  await fs.writeFile(path, JSON.stringify(state, null, 2), "utf8");
}
