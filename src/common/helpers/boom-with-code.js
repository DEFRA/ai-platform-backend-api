import Boom from '@hapi/boom'

/**
 * Creates a Boom error carrying a stable `code` for the frontend to map to a message.
 * @param {(message?: string) => import('@hapi/boom').Boom} boomFactory - e.g. Boom.forbidden
 * @param {string} message
 * @param {string} code
 */
export function boomWithCode(boomFactory, message, code) {
  const error = boomFactory(message)
  error.data = { code }
  return error
}

export { Boom }
