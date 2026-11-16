import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'

// What a Platform Admin's action that takes an Idempotency-Key and a reason
// shares (B31): the id of the success event the key makes, and the check of a
// repeat against it. Used by the credential and the team actions.

/**
 * The id of the success event an Idempotency-Key makes for an action: the
 * team, the environment when the action is for one, and the key.
 * @param {string} action
 * @param {{teamId: string, environment?: string, idempotencyKey: string}} parts
 * @returns {string}
 */
export function eventIdOf(action, { teamId, environment, idempotencyKey }) {
  return [action, teamId, environment, idempotencyKey].filter(Boolean).join(':')
}

/**
 * Whether this Idempotency-Key already did this action: the success event it
 * wrote is the record. The same key with another reason is another request:
 * `409 idempotency-key-reused`, so a caller is never told their reason was
 * saved when another was.
 * @param {import('mongodb').Db} db
 * @param {string} eventId
 * @param {string} reason
 * @returns {Promise<boolean>}
 */
export async function isReplay(db, eventId, reason) {
  const earlier = await db
    .collection('auditEvents')
    .findOne({ _id: eventId }, { projection: { reason: 1 } })

  if (!earlier) {
    return false
  }

  if (earlier.reason !== reason) {
    throw boomWithCode(
      Boom.conflict,
      'This idempotency key was used for a different request',
      'idempotency-key-reused'
    )
  }

  return true
}
