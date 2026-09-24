import Boom from '@hapi/boom'

/**
 * Creates a Boom error carrying a stable `code` for the frontend to map to a message,
 * plus any extra context fields (e.g. a link to an existing resource on a 409).
 * @param {(message?: string) => import('@hapi/boom').Boom} boomFactory - e.g. Boom.forbidden
 * @param {string} message
 * @param {string} code
 * @param {object} [extra]
 */
export function boomWithCode(boomFactory, message, code, extra = {}) {
  const error = boomFactory(message)
  error.data = { code, ...extra }
  return error
}

export { Boom }
