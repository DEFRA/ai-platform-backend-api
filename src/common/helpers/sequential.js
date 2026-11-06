/**
 * Yields each step's result in order, starting a step only once the previous
 * one has settled. A rejection ends the iteration, so no later step runs.
 * `yield` waits for a promise in an async generator, so no chain is built up
 * front and memory does not grow with the batch beyond the results.
 * @template T, R
 * @param {Iterable<T>} items
 * @param {(item: T, index: number) => Promise<R>|R} step
 * @returns {AsyncGenerator<R>}
 */
async function* stepsInOrder(items, step) {
  let index = 0

  for (const item of items) {
    yield step(item, index)
    index += 1
  }
}

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
export async function mapSequentially(items, step) {
  const results = []

  for await (const result of stepsInOrder(items, step)) {
    results.push(result)
  }

  return results
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
