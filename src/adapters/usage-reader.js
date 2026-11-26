/**
 * What the gateway recorded for model calls, read per request and summed per
 * day, team API and deployment. Counts only: no prompt, response, name or
 * email address ever passes through it.
 * @typedef {object} UsageRow
 * @property {string} day - UTC date, `YYYY-MM-DD`
 * @property {string} teamSlug - the gateway API the call went through
 * @property {string} deployment - `{teamSlug}-{modelSlug}`
 * @property {number} requests
 * @property {number} promptTokens
 * @property {number} completionTokens
 */

/**
 * @typedef {object} UsageReader
 * @property {string} source - where the figures come from, `log-analytics` or `mock`
 * @property {(params: {environment: string, from: string, to: string, teamSlug?: string, signal?: AbortSignal}) => Promise<UsageRow[]>} readUsage
 *   Calls from `from` (inclusive) to `to` (exclusive), both `YYYY-MM-DD`, for one team's API or, with no `teamSlug`, every API. Throws an error with `code` `usage-not-available` for an environment it has no source for.
 */

export const USAGE_NOT_AVAILABLE = 'usage-not-available'

/**
 * @param {string} message
 * @returns {Error & {code: string}}
 */
export function usageNotAvailable(message) {
  return Object.assign(new Error(message), { code: USAGE_NOT_AVAILABLE })
}
