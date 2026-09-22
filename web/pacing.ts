/** Returns the progressive delay between automatic batches, capped at 60s. */
export function nextBatchDelay(tested: number) {
  const progress = Math.min(1, Math.max(0, (tested - 2_000) / 48_000));
  return (1 + 59 * progress ** 2) * 1_000;
}
