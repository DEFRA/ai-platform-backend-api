import { getTraceId } from '@defra/hapi-tracing'

/**
 * Writes an immutable audit event. Never persist secrets, tokens or payloads here.
 * @param {import('mongodb').Db} db
 * @param {{actorUserId: string, action: string, resource: string, resourceId: string, outcome: 'success'|'failure', code?: string}} params
 */
export async function recordAuditEvent(
  db,
  { actorUserId, action, resource, resourceId, outcome, code }
) {
  await db.collection('auditEvents').insertOne({
    // stored as a Date (not ISO string) so the auditEvents TTL index can expire it
    at: new Date(),
    actorUserId,
    action,
    resource,
    resourceId,
    outcome,
    code: code ?? null,
    requestId: getTraceId() ?? null
  })
}
