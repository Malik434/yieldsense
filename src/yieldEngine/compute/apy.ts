export function totalAprToApy(totalApr: number, compoundsPerYear: number): number {
  if (compoundsPerYear <= 0) return totalApr;
  const n = compoundsPerYear;
  return Math.pow(1 + totalApr / n, n) - 1;
}
