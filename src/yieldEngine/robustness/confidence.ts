export interface ConfidenceInputs {
  coverageRatio: number;
  /** 0-1 penalty from CV of daily fee buckets (optional) */
  feeVariancePenalty: number;
  /** min of oracle staleness scores 0-1 */
  oracleScore: number;
  /** gauge health 0-1 */
  gaugeScore: number;
  /** subgraph vs rpc divergence 0-1, 1 if N/A */
  consistencyScore: number;
}

export function compositeConfidence(c: ConfidenceInputs): number {
  const base = Math.min(c.coverageRatio, c.oracleScore);
  return Math.max(
    0,
    Math.min(1, base * c.feeVariancePenalty * c.consistencyScore * c.gaugeScore)
  );
}

/** Reduce confidence when strategy delta is large vs pool TVL. */
export function liquiditySensitivityPenalty(tvlUsd: number, strategyDeltaUsd: number | undefined): number {
  if (!strategyDeltaUsd || strategyDeltaUsd <= 0 || tvlUsd <= 0) return 1;
  const ratio = strategyDeltaUsd / tvlUsd;
  if (ratio <= 0.01) return 1;
  if (ratio >= 0.5) return 0.5;
  return 1 - ratio * 0.5;
}
