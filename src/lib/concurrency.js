import os from 'node:os';

export const DEFAULT_CONCURRENCY = Math.max(1, Math.min(os.cpus().length || 4, 8));

/**
 * Run an async function over an array with bounded concurrency, preserving order.
 * @template T
 * @template R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function runWithConcurrency(items, concurrency, fn) {
  if (items.length === 0) return [];

  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));

  return results;
}
