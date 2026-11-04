import { recordAuditEvent } from '#/services/audit-service.js'
import {
  SYSTEM_PRINCIPAL_ID,
  systemActor
} from '#/common/helpers/auth/system-actor.js'

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
 * The principal the backend attributes its own operations (a revert) and
 * audits its own steps to, in place of a person.
 */
export const SYSTEM_ACTOR = SYSTEM_PRINCIPAL_ID

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
 * Records an audit event against one deployment entry, as the backend
 * itself unless an actor is given. A request's change passes the `actor`
 * (the token's credentials) and the `role` it used.
 * @param {import('mongodb').Db} db
 * @param {{id: string}} entry
 * @param {{action: string, outcome?: string, actor?: object, role?: string, actorUserId?: string, code?: string, reason?: string, eventId?: string}} event
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
    eventId
  }
) {
  const isSystemStep =
    !actor && (actorUserId === undefined || actorUserId === SYSTEM_PRINCIPAL_ID)

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
    eventId
  })
}
