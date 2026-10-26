import {
  compareAndSet,
  findOperation
} from '#/operations/operation-repository.js'
import { projectOperation } from '#/operations/operation-projection.js'
import { deadlineFor, TIMED_OUT } from '#/operations/operation-state-machine.js'
import { auditDeployment } from '#/services/team-deployment-entries.js'

// The one way an operation changes after it is created: compare-and-set on
// `stateVersion`, then the projection onto the entries and one audit event
// per transition per item. The state machine decides; this persists.

const FAILED = new Set(['checks-failed', 'deploy-failed', TIMED_OUT])

function dotted(prefix, facts) {
  return Object.fromEntries(
    Object.entries(facts).map(([key, value]) => [`${prefix}.${key}`, value])
  )
}

/**
 * Writes one change to an operation by compare-and-set and projects it.
 * `state` moves it (recording history, resetting the deadline and
 * `reconcileCount`, as any accepted event does); `facts` fill or replace
 * `gitops` fields; `set` and `unset` change anything else.
 * @param {{db: import('mongodb').Db, settings: object, logger?: import('pino').Logger}} ctx
 * @param {object} operation - as read
 * @param {{state?: string, facts?: object, set?: object, unset?: string[], push?: object, addToSet?: object, source?: string, eventId?: string|null, eventAt?: string, deadlineAt?: string|null, audit?: {action: string, outcome?: string, code?: string, reason?: string}}} change
 * @returns {Promise<object|null>} The operation as written, or null when it had moved.
 */
export async function writeOperation(ctx, operation, change) {
  const { db, settings } = ctx
  const now = new Date().toISOString()
  const set = {
    updatedAt: now,
    ...dotted('gitops', change.facts ?? {}),
    ...change.set
  }
  const unset = [...(change.unset ?? [])]
  const push = { ...change.push }

  if (change.state) {
    set.state = change.state
    set.reconcileCount = 0

    if (operation.state === TIMED_OUT) {
      unset.push('leftState')
    }

    push.history = {
      state: change.state,
      at: change.eventAt ?? now,
      receivedAt: now,
      source: change.source ?? 'backend',
      eventId: change.eventId ?? null
    }
  }

  if (change.deadlineAt !== undefined) {
    set.deadlineAt = change.deadlineAt
  } else if (change.state) {
    set.deadlineAt = deadlineFor(change.state, settings)
  }

  const written = await compareAndSet(db, operation, {
    set,
    unset,
    push: Object.keys(push).length > 0 ? push : undefined,
    addToSet: change.addToSet
  })

  if (!written) {
    return null
  }

  await projectOperation(db, written)

  if (change.state) {
    await auditTransition(ctx, operation, written, change)
  }

  return written
}

// One audit event per item, like the single-model operations before it.
async function auditTransition({ db, logger }, before, written, change) {
  const failed = FAILED.has(written.state)

  for (const { entryId } of written.items ?? []) {
    try {
      await auditDeployment(
        db,
        { id: entryId },
        {
          action: change.audit?.action ?? 'teamDeployment.transition',
          outcome: change.audit?.outcome ?? (failed ? 'failure' : 'success'),
          code: change.audit?.code ?? written.state,
          reason: change.audit?.reason ?? `${before.state} -> ${written.state}`
        }
      )
    } catch (error) {
      // Diagnostics: a failed audit write never undoes the transition.
      logger?.warn(
        { operationId: written._id, message: error.message },
        'The operation transition could not be audited'
      )
    }
  }
}

/**
 * Writes a change, re-reading and trying again when another writer moved
 * the operation first, up to `attempts` times.
 * @param {{db: import('mongodb').Db}} ctx
 * @param {string} operationId
 * @param {(operation: object) => object|null} changeOf - null to stop (nothing left to do)
 * @param {number} [attempts]
 * @returns {Promise<object|null>} The operation as written, or null when there was nothing to write.
 */
export async function writeWithRetry(ctx, operationId, changeOf, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const operation = await findOperation(ctx.db, operationId)
    const change = operation ? changeOf(operation) : null

    if (!change) {
      return null
    }

    const written = await writeOperation(ctx, operation, change)

    if (written) {
      return written
    }
  }

  throw new Error(`Operation ${operationId} kept moving; try again`)
}
