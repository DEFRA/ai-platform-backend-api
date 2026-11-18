import { ObjectId } from 'mongodb'

import { mapSequentially } from '#/common/helpers/sequential.js'
import { recordAuditEvent } from '#/services/audit-service.js'

// A Platform Admin's change and its audit event are two writes, and MongoDB
// here has no transaction across them. So the event is staged first, in its
// own collection (the reason never sits on a document a team can read), and the
// change marks its own document with the staged id in the same single-document
// update. Once the event is recorded the marker and the staged event go. If
// recording fails, the marker stays: the next Disable, Enable or Revoke under
// the same lock records the event first (and its access hook), so a retry
// finds the change already audited instead of a no-op that never will be.

const STAGED = 'pendingAudits'
const MARKER = 'pendingAuditId'
const DUPLICATE_KEY = 11000

/**
 * What a change sets on its own document, in the same update, to say its audit
 * event is not yet recorded.
 * @param {string} id - the id given to `stageAudit`
 * @returns {{pendingAuditId: string}}
 */
export function pendingMarker(id) {
  return { [MARKER]: id }
}

/**
 * A document without its pending-audit marker, for any view a team can read:
 * the marker is internal and says an admin change is not yet audited.
 * @template {object} T
 * @param {T} doc
 * @returns {Omit<T, 'pendingAuditId'>}
 */
export function withoutPendingMarker(doc) {
  const { [MARKER]: _marker, ...rest } = doc

  return rest
}

// Only the named claims the audit event keeps: never the email, name or token.
function claimsOf({ userId, oid, tid, azp, uti }) {
  return { userId, oid, tid, azp, uti }
}

/**
 * Stages an audit event before the change it describes, under an id the
 * change's document will carry. An event with no `eventId` is given one, so
 * recording it twice cannot write it twice. Staging again under the same id
 * replaces the earlier one: the caller settles what was pending first.
 * @param {import('mongodb').Db} db
 * @param {string} id - names the document the change is made to
 * @param {{actor: object, change?: string, eventId?: string}} staged - `change` is what the access hook is told; the rest is the `recordAuditEvent` parameters
 * @returns {Promise<void>}
 */
export async function stageAudit(db, id, { actor, change, ...event }) {
  await db.collection(STAGED).replaceOne(
    { _id: id },
    {
      actor: claimsOf(actor),
      change,
      event: { ...event, eventId: event.eventId ?? new ObjectId().toString() },
      at: new Date()
    },
    { upsert: true }
  )
}

/**
 * Drops a staged event whose change did not happen.
 * @param {import('mongodb').Db} db
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function discardStagedAudit(db, id) {
  await db.collection(STAGED).deleteOne({ _id: id })
}

// A repeat of an insert the first attempt already made is the success the
// repeat wanted.
async function recordOnce(db, { actor, event, at }) {
  try {
    await recordAuditEvent(db, { ...event, actor, at })
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY) {
      throw error
    }
  }
}

async function settleOne(db, holder, { _id, [MARKER]: id }, notify) {
  const staged = await db.collection(STAGED).findOne({ _id: id })

  if (staged) {
    await recordOnce(db, staged)
    await notify?.(staged)
  }

  await db
    .collection(holder)
    .updateOne({ _id, [MARKER]: id }, { $unset: { [MARKER]: '' } })
  await discardStagedAudit(db, id)

  return staged?.event.eventId
}

/**
 * Records the audit event of every change in `holder` that matches `filter`
 * and still carries a marker, calls `notify` once for each, and clears the
 * marker. The caller holds the lock the changes were made under.
 * @param {import('mongodb').Db} db
 * @param {string} holder - the collection the changes were made in
 * @param {object} filter - the documents to look at
 * @param {(staged: {actor: object, change?: string, event: object}) => Promise<void>} [notify]
 * @returns {Promise<string[]>} the ids of the events this call recorded
 */
export async function settlePendingAudits(db, holder, filter, notify) {
  const held = await db
    .collection(holder)
    .find({ ...filter, [MARKER]: { $exists: true } })
    .project({ [MARKER]: 1 })
    .toArray()
  // One at a time: each settle records an event and may call the access hook.
  const settled = await mapSequentially(held, (doc) =>
    settleOne(db, holder, doc, notify)
  )

  return settled.filter(Boolean)
}
