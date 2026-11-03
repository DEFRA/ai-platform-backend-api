import { createLogger } from './logging/logger.js'

const logger = createLogger()

/**
 * The route validation failure hook. A validation error carries the request
 * it refused (`_original`, and each detail's `context.value`), so it is never
 * logged whole: a search text, a name or an email in a payload would reach
 * the log. The log holds only the paths and rules that failed. The error is
 * rethrown as it is for the client.
 * @param {import('@hapi/hapi').Request} _request
 * @param {import('@hapi/hapi').ResponseToolkit} _h
 * @param {Error & {details?: object[], data?: {details?: object[]}}} error
 */
export function failAction(_request, _h, error) {
  const details = error?.details ?? error?.data?.details

  if (Array.isArray(details)) {
    logger.warn(
      {
        validation: details.map(({ path, type }) => ({
          path: Array.isArray(path) ? path.join('.') : undefined,
          type
        }))
      },
      'Request validation failed'
    )
  } else {
    logger.warn(error, error?.message)
  }

  throw error
}
