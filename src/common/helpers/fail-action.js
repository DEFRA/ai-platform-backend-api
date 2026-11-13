import { createLogger } from './logging/logger.js'
import { boomWithCode, Boom } from './boom-with-code.js'

const logger = createLogger()

function logRefusal(error) {
  const details = error?.details ?? error?.data?.details

  if (Array.isArray(details)) {
    logger.warn(
      { validation: details.map(({ type }) => ({ type })) },
      'Request validation failed'
    )
  } else {
    logger.warn(error, error?.message)
  }
}

/**
 * The route validation failure hook. A validation error carries the request
 * it refused (`_original`, and each detail's `context.value`), so it is never
 * logged whole: a search text, a name or an email in a payload would reach
 * the log. A path is not logged either, because a key the caller invented
 * (`object.unknown`) is part of it. The log holds only the rule types that
 * failed. The error is rethrown as it is for the client.
 * @param {import('@hapi/hapi').Request} _request
 * @param {import('@hapi/hapi').ResponseToolkit} _h
 * @param {Error & {details?: object[], data?: {details?: object[]}}} error
 */
export function failAction(_request, _h, error) {
  logRefusal(error)

  throw error
}

/**
 * A validation failure hook for a route whose callers map a stable error
 * `code` (for example `invalid-query`): logged as {@link failAction} logs it,
 * then answered `400` with the code and a fixed message, so the refused value
 * is never echoed back.
 * @param {string} code
 * @param {string} message
 * @returns {import('@hapi/hapi').Lifecycle.FailAction}
 */
export function failActionWithCode(code, message) {
  return function failWithCode(_request, _h, error) {
    logRefusal(error)

    throw boomWithCode(Boom.badRequest, message, code)
  }
}
