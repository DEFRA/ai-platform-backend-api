import { recordAuditEvent } from '#/services/audit-service.js'

/**
 * GitOps states an operation can still move on from - the only ones polled.
 */
export const NON_TERMINAL_STATUSES = [
  'requested',
  'pr-raised',
  'merged',
  'deploying',
  'deployed',
  'verified'
]

/**
 * A request waiting for the operation in flight on its team file: submit
 * allows one open operation per file, so it is dispatched once that ends.
 */
export const QUEUED = 'queued'

/**
 * The GitOps state an operation ends in when its pull request fails checks
 * or is closed unmerged.
 */
export const CHECKS_FAILED = 'checks-failed'

/**
 * The GitOps state an operation ends in when its apply fails for good.
 */
export const DEPLOY_FAILED = 'deploy-failed'

/**
 * An active deployment whose removal operation (`gitops.remove`) is in
 * progress; it ends `removed`, or back at `active` if the removal failed.
 */
export const REMOVING = 'removing'

/**
 * A deployment the team removed: its resources are gone and its grant with
 * them. Terminal, never polled.
 */
export const REMOVED = 'removed'

/**
 * GitOps states that end an operation as failed.
 */
export const TERMINAL_FAILURE_STATUSES = new Set([CHECKS_FAILED, DEPLOY_FAILED])

/**
 * The principal the backend submits its own GitOps operations (D14 reverts,
 * abandons) and audits its own steps as, in place of a person.
 */
export const SYSTEM_ACTOR = 'app:ai-platform-backend'

/**
 * The team's Entra app registration identifiers from its run report
 * resources, or null when Entra skipped it (`entra.enabled` off, or
 * `entra.teamRegistrations` false). Identifiers only, never a secret.
 * @param {{registration?: {client_id?: string, object_id?: string, service_principal_object_id?: string}|null}|null} [resources]
 * @returns {{clientId: string, objectId: string, servicePrincipalObjectId: string}|null}
 */
export function appRegistrationOf(resources) {
  const registration = resources?.registration

  if (!registration?.object_id) {
    return null
  }

  return {
    clientId: registration.client_id,
    objectId: registration.object_id,
    servicePrincipalObjectId: registration.service_principal_object_id
  }
}

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
 * Compare-and-set filter for one entry: matches only while it still has the
 * status read, so a slower concurrent writer never overwrites a newer one.
 * @param {{_id: import('mongodb').ObjectId}} doc
 * @param {{id: string, status: string}} entry
 */
export function entryFilter(doc, entry) {
  return {
    _id: doc._id,
    deployments: { $elemMatch: { id: entry.id, status: entry.status } }
  }
}

/**
 * The `$set` fields for the entry an `entryFilter` matched, through the
 * positional operator.
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
export function entryFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      `deployments.$.${key}`,
      value
    ])
  )
}

/**
 * Records an audit event against one deployment entry, as the backend
 * itself unless an actor is given.
 * @param {import('mongodb').Db} db
 * @param {{id: string}} entry
 * @param {{action: string, outcome?: string, actorUserId?: string, code?: string, reason?: string}} event
 */
export async function auditDeployment(
  db,
  entry,
  { action, outcome = 'success', actorUserId = SYSTEM_ACTOR, code, reason }
) {
  await recordAuditEvent(db, {
    actorUserId,
    action,
    resource: 'teamDeployment',
    resourceId: entry.id,
    outcome,
    code,
    reason
  })
}
