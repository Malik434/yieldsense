import type { FeeIndexResult } from "../types.js";

const SECONDS_PER_YEAR = 31_536_000;

export function annualizedFeeApr(feeUsd: number, tvlUsdTwab: number, windowSec: number): number {
  if (tvlUsdTwab <= 0 || windowSec <= 0) return 0;
  return (feeUsd / tvlUsdTwab) * (SECONDS_PER_YEAR / windowSec);
}

export function feeAprFromIndex(
  index: FeeIndexResult,
  tvlUsdTwab: number,
  useHarmonicTvl: boolean,
  harmonicTvl?: number
): number {
  const denom = useHarmonicTvl && harmonicTvl && harmonicTvl > 0 ? harmonicTvl : tvlUsdTwab;
  return annualizedFeeApr(index.feeUsd, denom, index.windowSecActual);
}
