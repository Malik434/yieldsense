import type { RewardGaugeSnapshot } from "../types.js";

export interface ForwardAerodromeParams {
  snapshot: RewardGaugeSnapshot;
  feeApr: number;
  /** expected seconds until next emission regime change (e.g. epoch length) */
  epochHorizonSec: number;
}

/**
 * v1 forward estimate: extrapolate current emission rate through horizon when periodFinish allows.
 * Full voter-weight modeling can replace this when Voter ABI + pool vote share are wired.
 */
export function estimateForwardApr(params: ForwardAerodromeParams): {
  rewardApr: number;
  totalApr: number;
  notes: string[];
} {
  const notes: string[] = [
    "Forward reward APR uses current rewardRate; no vote/bribe model in v1.",
  ];
  const now = Math.floor(Date.now() / 1000);
  const pf = Number(params.snapshot.periodFinish);
  const horizonEnd = now + params.epochHorizonSec;
  if (pf < horizonEnd) {
    notes.push("periodFinish before horizon; forward APR may drop after refill.");
  }
  const rewardForward = params.snapshot.rewardAprInstant;
  const total = params.feeApr + rewardForward;
  return { rewardApr: rewardForward, totalApr: total, notes };
}
