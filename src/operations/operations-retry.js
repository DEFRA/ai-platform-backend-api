import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'
import { newOutboxEntry } from '#/operations/operation-factory.js'
import {
  findOperation,
  isDuplicateKey
} from '#/operations/operation-repository.js'
import {
  DEPLOYING,
  DEPLOY_FAILED,
  RANK,
  TIMED_OUT
} from '#/operations/operation-state-machine.js'
import {
  writeOperation,
  writeWithRetry
} from '#/operations/operation-writer.js'
import { endRefused } from '#/operations/operations-slots.js'
import {
  MAX_TRIES,
  busyConflict,
  isPolicyRefusal,
  publish,
  withSubmit
} from '#/operations/operations-support.js'

// Resubmitting a held write, publishing a fresh apply, reconciling and the
// admin retry. Each function takes the service's context
// ({db, settings, logger, relay, buildDocument, reader, controls}).

// What a resubmission records besides the new submit. At a held deadline
// (`passed`) it counts the pass, so the next hold doubles, and keeps the
// first hold time for the alarm; any other resubmission starts afresh.
function resubmitRecord(operation, { counted, passed }) {
  const set = {
    resubmitCount: (operation.resubmitCount ?? 0) + (counted ? 1 : 0)
  }

  if (!passed) {
    return { set, unset: ['held', 'deferred', 'heldSince'] }
  }

  return {
    set: {
      ...set,
      heldPasses: (operation.heldPasses ?? 0) + 1,
      heldSince:
        operation.heldSince ?? operation.held?.since ?? new Date().toISOString()
    },
    unset: ['held', 'deferred']
  }
}

/**
 * Rebuilds a held write from main and publishes it again: after a
 * `stale-revision` or `commit-conflict` (counted, at most
 * `GITOPS_RESUBMIT_MAX`), a resume, or the held deadline (`passed`: the
 * submit reads the pause itself and, if it stands, the hold doubles).
 * @param {object} ctx
 * @param {string} operationId
 * @param {{counted?: boolean, passed?: boolean}} [options]
 * @returns {Promise<object|null>}
 */
export async function resubmit(
  ctx,
  operationId,
  { counted = false, passed = false } = {}
) {
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const operation = await findOperation(ctx.db, operationId)

    if (!operation?.slot) {
      return null
    }

    let submission

    try {
      submission = await ctx.buildDocument(operation)
    } catch (error) {
      if (!isPolicyRefusal(error)) {
        throw error
      }

      return endRefused(ctx, operation, error)
    }

    const submit = withSubmit(operation, submission)
    const record = resubmitRecord(operation, { counted, passed })
    const written = await writeOperation(ctx, operation, {
      state: 'requested',
      source: 'backend',
      ...submit,
      set: { ...submit.set, ...record.set },
      unset: record.unset
    })

    if (written) {
      await publish(ctx, operationId)

      return written
    }
  }

  throw new Error(`Operation ${operationId} kept moving; try again`)
}

// The change that publishes a fresh apply. At a deferred deadline (`passed`)
// it counts the pass, so a paused apply's next deferral doubles.
function applyChange(operation, { attempt, state, reset, passed }) {
  const next = attempt ?? operation.attempt

  return {
    ...(state ? { state, source: 'backend' } : {}),
    set: {
      attempt: next,
      retrying: true,
      outboxPending: true,
      ...(passed ? { heldPasses: (operation.heldPasses ?? 0) + 1 } : {}),
      ...(reset ? { verify: { attempts: 0, nextAt: null } } : {})
    },
    unset: ['deferred', 'held', ...(reset ? ['error'] : [])],
    push: { outbox: newOutboxEntry('apply', { attempt: next }) }
  }
}

/**
 * Publishes a fresh apply for an operation, at `attempt`: the one D14 retry,
 * an admin's retry, or a deferred retry re-armed.
 * @param {object} ctx
 * @param {string} operationId
 * @param {{attempt?: number, state?: string, reset?: boolean, passed?: boolean}} [options]
 * @returns {Promise<object|null>}
 */
export async function publishApply(ctx, operationId, options = {}) {
  const written = await writeWithRetry(ctx, operationId, (operation) =>
    applyChange(operation, options)
  )

  if (written) {
    await publish(ctx, operationId)
  }

  return written
}

/**
 * Publishes a `reconcile` for an operation: the worker looks for what
 * GitHub holds for it and reports the true state (plan 5).
 * @param {object} ctx
 * @param {string} operationId
 * @param {{extendDeadline?: boolean}} [options]
 * @returns {Promise<object|null>}
 */
export async function reconcile(
  ctx,
  operationId,
  { extendDeadline = false } = {}
) {
  const written = await writeWithRetry(ctx, operationId, (operation) => ({
    set: {
      outboxPending: true,
      ...(extendDeadline
        ? {
            reconcileCount: (operation.reconcileCount ?? 0) + 1,
            deadlineAt: new Date(
              Date.now() + ctx.settings.reconcileGraceMs
            ).toISOString()
          }
        : {})
    },
    push: {
      outbox: newOutboxEntry('reconcile', operation, {
        state: operation.state
      })
    }
  }))

  await publish(ctx, operationId)

  return written
}

/**
 * Re-takes the slot of an operation that ended, for a retry by an admin;
 * refused while another operation holds the file.
 * @param {object} ctx
 * @param {object} operation
 */
async function reacquireSlot(ctx, operation) {
  if (operation.slot) {
    return operation
  }

  try {
    const written = await writeWithRetry(ctx, operation._id, (current) =>
      current.slot ? null : { set: { slot: 'active' } }
    )

    return written ?? (await findOperation(ctx.db, operation._id))
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw busyConflict()
    }

    throw error
  }
}

function assertRetryable(operation) {
  if (
    operation.state !== TIMED_OUT &&
    operation.state !== DEPLOY_FAILED &&
    !operation.held
  ) {
    throw boomWithCode(
      Boom.conflict,
      'Only a failed deployment can be retried',
      'deployment-not-retryable'
    )
  }
}

/**
 * A Platform Admin retry, by state (plan 5): a failed apply gets a fresh
 * apply (attempt + 1, the verification count starting again); a
 * `timed-out` operation resumes from the state it left (a submit before
 * `committed`, an apply after); a held write is rebuilt and resubmitted.
 * @param {object} ctx
 * @param {object} operation
 * @returns {Promise<object>}
 */
export async function retry(ctx, operation) {
  const leftOf =
    operation.state === TIMED_OUT ? operation.leftState : operation.state

  assertRetryable(operation)

  const held = await reacquireSlot(ctx, operation)

  if (RANK[leftOf] < RANK.committed) {
    return resubmit(ctx, held._id)
  }

  const failed = operation.state === DEPLOY_FAILED

  return publishApply(ctx, held._id, {
    attempt: failed ? operation.attempt + 1 : operation.attempt,
    state: failed ? DEPLOYING : leftOf,
    reset: true
  })
}
