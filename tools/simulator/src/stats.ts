/** Nearest-rank percentile (p in 0–100) of an unsorted list; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p < 0 || p > 100) throw new RangeError('p must be between 0 and 100');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function summarise(values: readonly number[]): LatencySummary {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    // reduce, not Math.max(...values): spreading 100 000+ values overflows the call stack.
    max: values.length === 0 ? null : values.reduce((a, b) => Math.max(a, b), -Infinity),
  };
}
