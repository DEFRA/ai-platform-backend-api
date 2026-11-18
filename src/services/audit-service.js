import { getTraceId } from '@defra/hapi-tracing'

import {
  SYSTEM_ROLE,
  TOKEN_SYSTEM
} from '#/common/helpers/auth/system-actor.js'

function actorClaims(actor) {
  return {
    oid: actor?.oid ?? null,
    tid: actor?.tid ?? null,
    azp: actor?.azp ?? null,
    uti: actor?.uti ?? null
  }
}

function roleOf(role, actor) {
  return role ?? (actor?.kind === TOKEN_SYSTEM ? SYSTEM_ROLE : null)
}

/**
 * Writes an immutable audit event. Never persist secrets, tokens or payloads here.
 *
 * A request's change passes the `actor` (the validated token's credentials), which
 * records who acted, `tid`, `azp`, `uti` and, as `role`, the right the action used
 * (`admin`, `owner`, `platform-admin`, `user`). The backend's own steps (the expiry
 * sweep, an operation's steps) pass the system actor, recorded with role `system` and
 * no person, tenant or token. `actorUserId` alone names a person a step acts for.
 * Only named claims are copied, so no token can reach a record.
 * @param {import('mongodb').Db} db
 * @param {{actor?: {userId?: string|null, oid?: string, tid?: string, azp?: string, uti?: string|null}, actorUserId?: string, role?: string|null, action: string, resource: string, resourceId: string, outcome: 'success'|'failure', code?: string, reason?: string, eventId?: string, subjectOid?: string, teamId?: string, environment?: string, environments?: string[], requestedEnvironments?: string[], at?: Date}} params - `eventId` makes the insert idempotent: a second insert of the same event fails with a duplicate key error; `subjectOid` is the Entra object ID of the person the action was done to (distinct from the actor's `oid`), never a name or email; `teamId` and `environment` name the team and the environment an event is about, left out when it names neither; `environments` lists the environments a team-wide action changed (Disable and Enable team), and may be empty; `requestedEnvironments` lists the environments the request asked for, so a repeat of its Idempotency-Key can be checked against it, and is never shown in the audit log; `at` is when the change happened, left out to mean now (a pending event that is recorded later passes the time it was staged)
 */
export async function recordAuditEvent(
  db,
  {
    actor,
    actorUserId = actor?.userId,
    role,
    action,
    resource,
    resourceId,
    outcome,
    code,
    reason,
    eventId,
    subjectOid,
    teamId,
    environment,
    environments,
    requestedEnvironments,
    at = new Date()
  }
) {
  await db.collection('auditEvents').insertOne({
    ...(eventId && { _id: eventId }),
    // stored as a Date (not ISO string) so the auditEvents TTL index can expire it
    at,
    actorUserId,
    ...actorClaims(actor),
    role: roleOf(role, actor),
    action,
    resource,
    resourceId,
    outcome,
    code: code ?? null,
    reason: reason ?? null,
    ...(subjectOid && { subjectOid }),
    ...(teamId && { teamId }),
    ...(environment && { environment }),
    ...(environments && { environments }),
    ...(requestedEnvironments && { requestedEnvironments }),
    requestId: getTraceId() ?? null
  })
}
