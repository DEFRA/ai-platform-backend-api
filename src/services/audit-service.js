import { getTraceId } from '@defra/hapi-tracing'

/**
 * Writes an immutable audit event. Never persist secrets, tokens or payloads here.
 * @param {import('mongodb').Db} db
 * @param {{actorUserId: string, action: string, resource: string, resourceId: string, outcome: 'success'|'failure', code?: string, reason?: string, eventId?: string}} params - `eventId` makes the insert idempotent: a second insert of the same event fails with a duplicate key error
 */
export async function recordAuditEvent(
  db,
  { actorUserId, action, resource, resourceId, outcome, code, reason, eventId }
) {
  await db.collection('auditEvents').insertOne({
    ...(eventId && { _id: eventId }),
    // stored as a Date (not ISO string) so the auditEvents TTL index can expire it
    at: new Date(),
    actorUserId,
    action,
    resource,
    resourceId,
    outcome,
    code: code ?? null,
    reason: reason ?? null,
    requestId: getTraceId() ?? null
  })
}
