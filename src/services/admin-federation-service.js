import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'
import {
  PLATFORM_ADMIN_ROLE,
  requirePlatformAdmin
} from '#/common/helpers/auth/access.js'
import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { eventIdOf, isReplay } from '#/services/admin-idempotency.js'
import { findTeamDeployment } from '#/services/admin-deployment-service.js'
import {
  recordStagedAudit,
  stageAudit
} from '#/services/admin-pending-audit.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { resolveTeamTarget } from '#/services/team-desired-state.js'
import { refusalOf } from '#/services/team-deployment-submission.js'
import { removeUnderLock } from '#/services/team-federation-remove.js'
import { underLock, viewOfEntry } from '#/services/team-federation-support.js'

const REMOVE_ACTION = 'admin.federation.remove'
const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'

// The staged event is marked on the application's entry, not the deployment
// document: the credentials' marker lives there, and the entry is only ever
// shown through named fields, so the marker never reaches a read. The removal
// stages it first and sets the marker in its own update, so a failed write
// either way leaves no event to be recorded for a removal that was not made.
async function stageRemoval(db, scope, federationId, staged) {
  const id = `federation-remove:${scope.teamId}:${scope.environment}:${federationId}`

  await stageAudit(db, id, staged)

  return id
}

// Records the event of a removal an earlier request projected and did not get
// to record, then clears the marker. Runs under the deployment's lock.
async function settleRemoval(db, scope, federationId) {
  const doc = await db
    .collection('teamDeployments')
    .findOne(scope, { projection: { federations: 1 } })
  const id = doc?.federations?.find(
    (entry) => entry.id === federationId
  )?.pendingAuditId

  if (!id) {
    return
  }

  await recordStagedAudit(db, id)
  await db
    .collection('teamDeployments')
    .updateOne(
      scope,
      { $unset: { 'federations.$[f].pendingAuditId': '' } },
      { arrayFilters: [{ 'f.id': federationId, 'f.pendingAuditId': id }] }
    )
}

/**
 * Removes a team's federated application as a Platform Admin, whatever the
 * team's status (B31): the built removal, past the team lock, with the Platform
 * Admin as actor. The removal is asked for at once (`done` false) and `done`
 * once the application is removed. One `admin.federation.remove` event is
 * about the application; a repeat of the Idempotency-Key and reason answers the
 * application as it is and records nothing, and the same key with another
 * reason is `409 idempotency-key-reused`. An application the deployment does
 * not hold is `404 federation-not-found`; one still being set up is `409
 * federation-in-progress`.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{actor: object, teamId: string, environment: string, federationId: string, reason: string, idempotencyKey: string, traceParent?: string, cdpRequestId?: string}} params - `actor` is the token's credentials; `reason` is kept in the audit event only
 * @param {{operations: ReturnType<typeof import('#/operations/operations-service.js').createOperationsService>, registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} deps
 * @returns {Promise<{federation: object, operationId: string|null, done: boolean, replay: boolean}>}
 */
export async function removeFederationAsPlatformAdmin(
  db,
  locker,
  {
    actor,
    teamId,
    environment,
    federationId,
    reason,
    idempotencyKey,
    traceParent,
    cdpRequestId
  },
  { operations, registry = tenantOrchestratorRegistry }
) {
  await requirePlatformAdmin(db, actor, {
    resource: 'teamDeployment',
    resourceId: teamId
  })

  const { doc } = await findTeamDeployment(db, { teamId, environment })

  if (!(doc.federations ?? []).some(({ id }) => id === federationId)) {
    throw boomWithCode(
      Boom.notFound,
      'This application is not available',
      'federation-not-found'
    )
  }

  const eventId = eventIdOf(REMOVE_ACTION, {
    teamId,
    environment,
    resourceId: federationId,
    idempotencyKey
  })
  const auditOf = (resourceId) => ({
    actor,
    role: PLATFORM_ADMIN_ROLE,
    action: REMOVE_ACTION,
    resource: 'teamFederation',
    resourceId,
    teamId,
    environment
  })
  const context = {
    db,
    actor,
    teamId,
    environment,
    traceParent,
    cdpRequestId,
    locker,
    operations,
    registry,
    target: await resolveTeamTarget(db, { teamId, environment })
  }

  return underLock(locker, teamId, environment, async () => {
    await settleRemoval(db, { teamId, environment }, federationId)

    if (await isReplay(db, eventId, reason)) {
      const federation = await viewOfEntry(
        db,
        { teamId, environment },
        federationId
      )

      return {
        federation,
        operationId: federation.operationId,
        done: false,
        replay: true
      }
    }

    const { federation, done } = await removeUnderLock(
      db,
      context,
      federationId,
      {
        stage: (entry) =>
          stageRemoval(db, { teamId, environment }, entry.id, {
            ...auditOf(entry.id),
            outcome: 'success',
            reason,
            eventId
          })
      }
    ).catch(async (error) => {
      const refusal = refusalOf(error, 'Failed to remove the application')

      await recordAuditEvent(db, {
        ...auditOf(federationId),
        outcome: 'failure',
        code: refusal.data?.code ?? UPSTREAM_UNAVAILABLE
      })

      throw refusal
    })

    await settleRemoval(db, { teamId, environment }, federationId)

    return {
      federation,
      operationId: federation.operationId,
      done,
      replay: false
    }
  })
}
