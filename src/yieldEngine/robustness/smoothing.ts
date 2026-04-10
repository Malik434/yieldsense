/** Discrete EWMA factor from half-life and elapsed seconds between updates. */
export function ewmaAlphaFromHalfLife(halfLifeSec: number, elapsedSec: number): number {
  if (halfLifeSec <= 0) return 1;
  const tau = halfLifeSec / Math.LN2;
  return 1 - Math.exp(-elapsedSec / tau);
}

export function updateEwma(previous: number, sample: number, alpha: number): number {
  return alpha * sample + (1 - alpha) * previous;
}

export function trimMean(values: number[], trimLower: number, trimUpper: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const lo = Math.floor(n * trimLower);
  const hi = Math.ceil(n * (1 - trimUpper));
  const slice = sorted.slice(lo, Math.max(lo + 1, hi));
  if (slice.length === 0) return sorted[Math.floor(n / 2)] ?? 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const varc =
    values.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(varc) / Math.abs(mean);
}
