import { statusCodes } from '#/common/constants/status-codes.js'

const DEFAULT_BACKOFF_MS = 60 * 1000
const MAX_BACKOFF_MINUTES = 15
const MAX_BACKOFF_MS = MAX_BACKOFF_MINUTES * 60 * 1000
const MAX_CACHED_URLS = 500
const RATE_LIMIT_STATUSES = new Set([
  statusCodes.forbidden,
  statusCodes.tooManyRequests
])

/**
 * Whether a GitHub error is a primary or secondary rate limit: a 403 or 429
 * that carries `retry-after`, or reports no requests remaining.
 * @param {{status?: number, response?: {headers?: Record<string, string>}}} error
 * @returns {boolean}
 */
export function isRateLimited(error) {
  const headers = error?.response?.headers ?? {}

  return (
    RATE_LIMIT_STATUSES.has(error?.status) &&
    (headers['retry-after'] !== undefined ||
      headers['x-ratelimit-remaining'] === '0')
  )
}

function hintedWaitMs(error, nowMs) {
  const headers = error.response.headers

  if (headers['retry-after'] !== undefined) {
    return Number(headers['retry-after']) * 1000
  }

  const resetAtMs = Number(headers['x-ratelimit-reset']) * 1000

  return Number.isFinite(resetAtMs) ? resetAtMs - nowMs : 0
}

function rateLimitedError(retryAtMs) {
  const error = new Error('GitHub rate limit reached, backing off')
  error.code = 'github-rate-limited'
  error.retryAt = new Date(retryAtMs).toISOString()
  return error
}

/**
 * Creates a reader for polling GitHub cheaply and politely (R11):
 * - every GET is conditional on the ETag of the last response for the same
 *   URL, and a `304 Not Modified` (which does not count against the rate
 *   limit) returns the cached body;
 * - a rate-limited response starts a backoff, at least what GitHub asked
 *   for (honoured in full) and otherwise doubling on each consecutive limit
 *   up to 15 minutes, during
 *   which every read fails fast with code `github-rate-limited` without
 *   calling GitHub. One success ends it.
 * The backoff is shared by everything using the reader, because GitHub's
 * limits apply to the App installation, not to one operation.
 * @param {{now?: () => number, maxCachedUrls?: number}} [options]
 * @returns {{read: (octokit: import('octokit').Octokit, route: string, params?: object) => Promise<any>}}
 */
export function createConditionalReader({
  now = Date.now,
  maxCachedUrls = MAX_CACHED_URLS
} = {}) {
  const cache = new Map()
  let backoffUntil = 0
  let backoffMs = 0

  function remember(url, entry) {
    cache.delete(url)
    cache.set(url, entry)

    if (cache.size > maxCachedUrls) {
      cache.delete(cache.keys().next().value)
    }
  }

  async function read(octokit, route, params = {}) {
    if (now() < backoffUntil) {
      throw rateLimitedError(backoffUntil)
    }

    const { url } = octokit.request.endpoint(route, params)
    const cached = cache.get(url)
    const headers = cached ? { 'if-none-match': cached.etag } : {}

    try {
      const response = await octokit.request(route, { ...params, headers })

      backoffMs = 0

      if (response.headers.etag) {
        remember(url, { etag: response.headers.etag, data: response.data })
      }

      return response.data
    } catch (error) {
      if (error.status === statusCodes.notModified && cached) {
        backoffMs = 0
        return cached.data
      }

      if (isRateLimited(error)) {
        // Our own backoff doubles up to the cap; GitHub's explicit wait is
        // honoured in full, however long, because requests before it are
        // still refused.
        backoffMs = Math.max(
          hintedWaitMs(error, now()),
          Math.min(
            MAX_BACKOFF_MS,
            backoffMs ? backoffMs * 2 : DEFAULT_BACKOFF_MS
          )
        )
        backoffUntil = now() + backoffMs

        throw rateLimitedError(backoffUntil)
      }

      throw error
    }
  }

  return { read }
}
