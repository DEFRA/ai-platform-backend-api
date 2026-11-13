import { recordAuditEvent } from '#/services/audit-service.js'
import {
  SYSTEM_PRINCIPAL_ID,
  systemActor
} from '#/common/helpers/auth/system-actor.js'

// SYSTEM_ACTOR is the principal the backend attributes its own operations (a
// revert) and audits its own steps to, in place of a person.
export { SYSTEM_PRINCIPAL_ID as SYSTEM_ACTOR } from '#/common/helpers/auth/system-actor.js'

/**
 * A request waiting for the operation in flight on its team file (or for
 * its paused environment): submit allows one open operation per file, so it
 * is submitted once that ends.
 */
export const QUEUED = 'queued'

/**
 * The state an operation ends in when its change fails the checks.
 */
export const CHECKS_FAILED = 'checks-failed'

/**
 * The state an operation ends in when its apply fails for good.
 */
export const DEPLOY_FAILED = 'deploy-failed'

/**
 * An active deployment whose removal operation is in progress; it ends
 * `removed`, or back at `active` if the removal failed.
 */
export const REMOVING = 'removing'

/**
 * A deployment the team removed: its resources are gone and its grant with
 * them. Terminal.
 */
export const REMOVED = 'removed'

/**
 * GitOps states that end an operation as failed.
 */
export const TERMINAL_FAILURE_STATUSES = new Set([CHECKS_FAILED, DEPLOY_FAILED])

/**
 * Finds one entry of a `teamDeployments` document's `deployments[]` by id.
 * @param {{deployments?: object[]}|null} doc
 * @param {string} id
 * @returns {object|undefined}
 */
export function findEntry(doc, id) {
  return doc?.deployments?.find((deployment) => deployment.id === id)
}

/**
 * The entry's `statusTimes` with the time it first reached `status`: a time
 * already recorded is kept, so a status revisited after a retry does not
 * move the steps already completed.
 * @param {Record<string, string>|undefined} statusTimes
 * @param {string} status
 * @param {string} at - ISO time
 * @returns {Record<string, string>}
 */
export function withStatusTime(statusTimes, status, at) {
  return { ...statusTimes, [status]: statusTimes?.[status] ?? at }
}

/**
 * The team and environment whose file holds the entry, for an event whose
 * caller knows only the entry's id. Nothing is returned when no file holds it
 * (an entry pulled after a refused request) or the read fails: the audit
 * write that follows must never fail because of a lookup.
 * @param {import('mongodb').Db} db
 * @param {string} entryId
 * @returns {Promise<{teamId?: string, environment?: string}>}
 */
async function locateEntry(db, entryId) {
  try {
    const file = await db
      .collection('teamDeployments')
      .findOne(
        { 'deployments.id': entryId },
        { projection: { teamId: 1, environment: 1 } }
      )

    return file ? { teamId: file.teamId, environment: file.environment } : {}
  } catch {
    return {}
  }
}

/**
 * Records an audit event against one deployment entry, as the backend
 * itself unless an actor is given. A request's change passes the `actor`
 * (the token's credentials) and the `role` it used. The event names the
 * team and environment of the entry's file: a caller that knows them passes
 * `teamId` and `environment`, otherwise they are read from the file holding
 * the entry.
 * @param {import('mongodb').Db} db
 * @param {{id: string}} entry
 * @param {{action: string, outcome?: string, actor?: object, role?: string, actorUserId?: string, code?: string, reason?: string, eventId?: string, teamId?: string, environment?: string}} event
 */
export async function auditDeployment(
  db,
  entry,
  {
    action,
    outcome = 'success',
    actor,
    role,
    actorUserId,
    code,
    reason,
    eventId,
    teamId,
    environment
  }
) {
  const isSystemStep =
    !actor && (actorUserId === undefined || actorUserId === SYSTEM_PRINCIPAL_ID)
  const where =
    teamId && environment
      ? { teamId, environment }
      : await locateEntry(db, entry.id)

  await recordAuditEvent(db, {
    actor: isSystemStep ? systemActor : actor,
    role,
    actorUserId,
    action,
    resource: 'teamDeployment',
    resourceId: entry.id,
    outcome,
    code,
    reason,
    eventId,
    ...where
  })
}
