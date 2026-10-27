/**
 * How long a graceful stop waits for work already running (a sweep, an events
 * handler) before it lets go, so MongoDB is not closed under it and shutdown
 * never hangs.
 */
export const DRAIN_TIMEOUT_MS = 5000

/**
 * Waits for the given promises to settle, but never longer than `timeoutMs`.
 * Resolves, never rejects: a failed piece of work is the caller's to log.
 * @param {Iterable<Promise<unknown>>} work
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export async function drain(work, timeoutMs = DRAIN_TIMEOUT_MS) {
  const pending = [...work]

  if (pending.length === 0) {
    return
  }

  let timer
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })

  try {
    await Promise.race([Promise.allSettled(pending), bound])
  } finally {
    clearTimeout(timer)
  }
}
