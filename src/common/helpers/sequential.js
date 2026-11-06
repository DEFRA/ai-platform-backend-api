/**
 * Runs an async function over each item strictly one after another, in
 * order, and resolves with the results in the same order. Use it where each
 * step must finish before the next starts (ordered writes, rate limits); use
 * `Promise.all` where the steps are independent.
 * @template T, R
 * @param {Iterable<T>} items
 * @param {(item: T, index: number) => Promise<R>|R} step
 * @returns {Promise<R[]>}
 */
export function mapSequentially(items, step) {
  const results = []

  return [...items]
    .reduce(
      (previous, item, index) =>
        previous
          .then(() => step(item, index))
          .then((result) => {
            results.push(result)
          }),
      Promise.resolve()
    )
    .then(() => results)
}

/**
 * Like `mapSequentially`, for steps whose results are not needed.
 * @template T
 * @param {Iterable<T>} items
 * @param {(item: T, index: number) => Promise<unknown>|unknown} step
 * @returns {Promise<void>}
 */
export async function forEachSequentially(items, step) {
  await mapSequentially(items, step)
}
