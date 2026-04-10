import type { RewardGaugeSnapshot } from "../types.js";
import { ewmaAlphaFromHalfLife, updateEwma } from "../robustness/smoothing.js";

export function smoothedRewardApr(
  snapshot: RewardGaugeSnapshot,
  prevEwm: number | null | undefined,
  halfLifeSec: number,
  elapsedSec: number
): { rewardApr: number; ewmNext: number } {
  const inst = snapshot.rewardAprInstant;
  if (prevEwm == null || !Number.isFinite(prevEwm)) {
    return { rewardApr: inst, ewmNext: inst };
  }
  const alpha = ewmaAlphaFromHalfLife(halfLifeSec, Math.max(60, elapsedSec));
  const ewmNext = updateEwma(prevEwm, inst, alpha);
  return { rewardApr: ewmNext, ewmNext };
}
