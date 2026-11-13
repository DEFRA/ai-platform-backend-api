import Joi from 'joi'

import { failActionWithCode } from '#/common/helpers/fail-action.js'

/** The longest reason a Platform Admin can give for an action on a team. */
export const MAX_REASON_LENGTH = 500

const REASON_REQUIRED = [
  'reason-required',
  'A reason is required, up to 500 characters'
]
const REASON_TOO_LONG = [
  'reason-too-long',
  'The reason must be 500 characters or fewer'
]
const INVALID_REQUEST = ['invalid-request', 'The request is not valid']

// What Joi calls a reason that is missing, empty (or only spaces, once
// trimmed), or not text.
const REQUIRED_TYPES = new Set([
  'any.required',
  'string.empty',
  'string.base',
  'object.base'
])

/**
 * The reason a Platform Admin gives for an action on a team (Disable, Revoke;
 * Disable and Delete team later), kept in the audit event only: 1 to 500
 * characters once trimmed.
 */
export const reasonField = Joi.string().trim().max(MAX_REASON_LENGTH).required()

/** The body of an action that takes a reason, and nothing else. */
export const reasonPayload = Joi.object({ reason: reasonField }).unknown(false)

function describeFailure(error) {
  const [first] = error?.details ?? error?.data?.details ?? []

  if (first?.path?.[0] !== 'reason' && first?.type !== 'object.base') {
    return INVALID_REQUEST
  }

  if (first.type === 'string.max') {
    return REASON_TOO_LONG
  }

  return REQUIRED_TYPES.has(first.type) ? REASON_REQUIRED : INVALID_REQUEST
}

/**
 * The validation failure hook of a route that takes a reason: `400
 * reason-required` or `400 reason-too-long` for the reason, `400
 * invalid-request` for anything else (a header, a path value, an unknown key).
 * Logged without the refused value, as {@link failActionWithCode} logs.
 * @param {import('@hapi/hapi').Request} request
 * @param {import('@hapi/hapi').ResponseToolkit} h
 * @param {Error & {details?: object[], data?: {details?: object[]}}} error
 */
export function reasonFailAction(request, h, error) {
  const [code, message] = describeFailure(error)

  return failActionWithCode(code, message)(request, h, error)
}
