// Bounded fan-out: `items.map(fn)` awaited together, with at most `concurrency` calls in flight.
// Every fan-out in the harness (dirty-tree snapshots, repomap reads, tokenize bursts) has a
// width that is an input property — how many files are dirty, how many words looped — so a bare
// Promise.all is a ceiling set by the data, not by us (#338). Results keep `items` order. A
// rejection propagates like Promise.all's, and no further items are started once one has failed.
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`mapLimit: concurrency must be a positive integer, got ${concurrency}`);
  }
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
