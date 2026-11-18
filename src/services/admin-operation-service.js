import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'
import {
  PLATFORM_ADMIN_ROLE,
  requirePlatformAdmin
} from '#/common/helpers/auth/access.js'
import {
  findOperation,
  findTeamFileOperation
} from '#/operations/operation-repository.js'
import { isRetryable } from '#/operations/operations-retry.js'
import { recordAuditEvent } from '#/services/audit-service.js'

const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'

function operationNotFound() {
  return boomWithCode(
    Boom.notFound,
    'There is no such change',
    'operation-not-found'
  )
}

function notRetryable() {
  return boomWithCode(
    Boom.conflict,
    'Only a change that failed, timed out or is held can be retried',
    'operation-not-retryable'
  )
}

/**
 * Platform Admin retry or reconcile of one operation, whatever its items: the
 * only way to recover a change that holds no model (a federation or limits
 * change). `retry` is the built retry (a failed apply gets a fresh apply, a
 * timed-out change resumes, a held write is resubmitted) and is `409
 * operation-not-retryable` where `isRetryable` says no; `reconcile` asks the
 * worker what GitHub holds, in any state. Both publish a command and answer at
 * once. A failed dispatch is `502 upstream-unavailable`, audited as a failure.
 * @param {import('mongodb').Db} db
 * @param {{operationId: string, actor: object, kind: 'retry'|'reconcile'}} params - `actor` is the token's credentials
 * @param {{operations: ReturnType<typeof import('#/operations/operations-service.js').createOperationsService>}} deps
 * @returns {Promise<{id: string, state: string}>}
 */
export async function redispatchOperation(
  db,
  { operationId, actor, kind },
  { operations }
) {
  await requirePlatformAdmin(db, actor, {
    resource: 'operation',
    resourceId: operationId
  })

  const operation = await findTeamFileOperation(db, operationId)

  if (!operation) {
    throw operationNotFound()
  }

  if (kind === 'retry' && !isRetryable(operation)) {
    throw notRetryable()
  }

  const audit = (extra) =>
    recordAuditEvent(db, {
      actor,
      role: PLATFORM_ADMIN_ROLE,
      action: `admin.operation.${kind}`,
      resource: 'operation',
      resourceId: operationId,
      teamId: operation.teamId,
      environment: operation.environment,
      ...extra
    })

  try {
    await operations[kind](kind === 'retry' ? operation : operationId)
  } catch (error) {
    if (error.isBoom) {
      throw error
    }

    await audit({ outcome: 'failure', code: UPSTREAM_UNAVAILABLE })

    throw boomWithCode(
      Boom.badGateway,
      'Failed to dispatch the change',
      UPSTREAM_UNAVAILABLE
    )
  }

  const { state } = (await findOperation(db, operationId)) ?? operation

  await audit({
    outcome: 'success',
    reason: state === operation.state ? null : `${operation.state} -> ${state}`
  })

  return { id: operationId, state }
}
