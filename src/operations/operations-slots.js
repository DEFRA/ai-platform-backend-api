import { buildOperation } from '#/operations/operation-factory.js'
import { FAILURE_CODES } from '#/operations/operation-projection.js'
import {
  findByIdempotencyKey,
  findOperation,
  findSlotHolder,
  insertOperation,
  isDuplicateKey
} from '#/operations/operation-repository.js'
import {
  OPERATION_TYPES,
  QUEUED,
  heldDeadline
} from '#/operations/operation-state-machine.js'
import {
  writeOperation,
  writeWithRetry
} from '#/operations/operation-writer.js'
import {
  MAX_TRIES,
  busyConflict,
  isPolicyRefusal,
  publish,
  withSubmit
} from '#/operations/operations-support.js'

// The file's slots (plan 5): who holds a team's file, who waits, and what
// happens when one ends. Each function takes the service's context
// ({db, settings, logger, relay, buildDocument, reader, controls}).

function heldSince() {
  return { code: 'paused', since: new Date().toISOString() }
}

function requestedDeadline(settings) {
  return new Date(Date.now() + settings.deadlines.requested).toISOString()
}

/**
 * The operation is ended as refused when its document cannot be built: the
 * request was fine when accepted but is no longer eligible, so waiting on
 * it would block the file.
 * @param {object} ctx
 * @param {object} operation
 * @param {Error} error
 * @returns {Promise<object>}
 */
export async function endRefused(ctx, operation, error) {
  const written = await writeWithRetry(ctx, operation._id, () => ({
    state: 'checks-failed',
    set: {
      error: {
        code: FAILURE_CODES.CHECKS_FAILED,
        message: error.message,
        retryable: false
      }
    },
    unset: ['held', 'deferred'],
    source: 'backend'
  }))

  await finish(ctx, written)

  return written
}

async function insertActive(ctx, base, held) {
  const { db, settings, buildDocument } = ctx
  const operation = buildOperation({
    ...base,
    state: held ? QUEUED : 'requested',
    slot: 'active',
    held
  })

  if (held) {
    operation.deadlineAt = heldDeadline(settings.deadlineHeldMs)
  } else {
    const submission = await buildDocument(operation)
    const { set, push } = withSubmit(operation, submission)

    Object.assign(operation, set)
    operation.outbox = [push.outbox]
    operation.deadlineAt = requestedDeadline(settings)
  }

  return insertOperation(db, operation)
}

async function queueBehind(ctx, base) {
  const { db } = ctx
  const { teamId, environment, items, idempotencyKeys } = base
  const waiting = await findSlotHolder(db, {
    environment,
    teamId,
    slot: 'waiting'
  })

  if (!waiting) {
    const operation = await insertOperation(
      db,
      buildOperation({ ...base, state: QUEUED, slot: 'waiting' })
    )

    return { operation, replay: false, waiting: true }
  }

  const merged = await writeOperation(ctx, waiting, {
    push: { items: { $each: items } },
    addToSet: { idempotencyKeys: { $each: idempotencyKeys } }
  })

  return merged ? { operation: merged, replay: false, waiting: true } : null
}

async function tryRequest(ctx, base, paused) {
  const { teamId, environment } = base
  const active = await findSlotHolder(ctx.db, {
    environment,
    teamId,
    slot: 'active'
  })

  try {
    if (!active) {
      const operation = await insertActive(
        ctx,
        base,
        paused ? heldSince() : undefined
      )

      await publish(ctx, operation._id)

      return { operation, replay: false, waiting: false }
    }

    return await queueBehind(ctx, base)
  } catch (error) {
    // A concurrent request took the slot or the key: look again.
    if (isDuplicateKey(error)) {
      return null
    }

    throw error
  }
}

/**
 * Accepts a request for a team file (plan 5, DD5): one operation per
 * request per file. A free file gets an active operation with its document
 * built now and its command in the outbox (or held, when the environment is
 * paused); a busy file gets a waiting operation, and requests arriving
 * meanwhile merge into it. A replayed idempotency key (a merged
 * request's too) finds its operation. Nothing is written when the document
 * cannot be built.
 * @param {object} ctx
 * @param {{teamId: string, environment: string, target: object, items: Array<{entryId: string, modelSlug: string, change: 'add'|'remove'}>, requestedBy: string, requestedByUserId: string, idempotencyKey: string, traceparent?: string|null, cdpRequestId?: string|null}} params
 * @returns {Promise<{operation: object, replay: boolean, waiting: boolean}>}
 */
export async function requestOperation(ctx, params) {
  const { teamId, environment, idempotencyKey } = params
  const base = {
    ...params,
    type: OPERATION_TYPES.WRITE,
    idempotencyKeys: [idempotencyKey]
  }
  const paused = await ctx.controls.isPaused(environment)

  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const replay = await findByIdempotencyKey(ctx.db, {
      teamId,
      key: idempotencyKey
    })

    if (replay) {
      return {
        operation: replay,
        replay: true,
        waiting: replay.slot === 'waiting'
      }
    }

    const result = await tryRequest(ctx, base, paused)

    if (result) {
      return result
    }
  }

  throw busyConflict()
}

async function promotionOf(ctx, waiting, paused) {
  if (paused) {
    return {
      set: { slot: 'active', held: heldSince() },
      deadlineAt: heldDeadline(ctx.settings.deadlineHeldMs)
    }
  }

  const submission = await ctx.buildDocument(waiting)
  const { set, push } = withSubmit(waiting, submission)

  return {
    state: 'requested',
    source: 'backend',
    set: { ...set, slot: 'active' },
    push
  }
}

/**
 * Gives the file to the waiting operation once nothing holds it (plan 5):
 * its document is built now, from main, and its command goes to the outbox;
 * paused, it holds. A document that can no longer be built ends it refused.
 * @param {object} ctx
 * @param {{environment: string, teamId: string}} file
 * @returns {Promise<object|null>} The promoted operation, or null.
 */
export async function promoteWaiting(ctx, { environment, teamId }) {
  const waiting = await findSlotHolder(ctx.db, {
    environment,
    teamId,
    slot: 'waiting'
  })

  if (!waiting) {
    return null
  }

  try {
    const paused = await ctx.controls.isPaused(environment)
    const change = await promotionOf(ctx, waiting, paused)
    const promoted = await writeOperation(ctx, waiting, change)

    if (promoted && !paused) {
      await publish(ctx, promoted._id)
    }

    return promoted
  } catch (error) {
    if (isDuplicateKey(error)) {
      return null
    }

    if (isPolicyRefusal(error)) {
      return endRefused(ctx, await findOperation(ctx.db, waiting._id), error)
    }

    throw error
  }
}

// What follows a revert's end for the operation it reverts (plan 5): a
// revert that landed ends the parent as reverted; one that failed leaves the
// file with the parent until an engineer acts, as a failed revert does today.
async function settleParent(ctx, child) {
  const succeeded = child.state === 'active'

  await writeWithRetry(ctx, child.parentId, () =>
    succeeded
      ? {
          set: {
            error: {
              code: FAILURE_CODES.REVERTED,
              message: 'The failed change was reverted',
              retryable: false
            }
          },
          unset: ['revertId', 'retrying']
        }
      : { set: { revertFailed: true }, unset: ['revertId'] }
  )

  if (succeeded) {
    const parent = await findOperation(ctx.db, child.parentId)

    await finish(ctx, parent)
  } else {
    ctx.logger?.error(
      { operationId: child.parentId, revertOperationId: child._id },
      'The revert did not complete: the file stays with the failed operation and needs a platform engineer'
    )
  }
}

/**
 * Frees an ended operation's file and promotes the waiting one; a revert's
 * end settles the operation it reverts.
 * @param {object} ctx
 * @param {object} operation - as written, in an ending state
 * @returns {Promise<void>}
 */
export async function finish(ctx, operation) {
  if (operation.slot) {
    await writeWithRetry(ctx, operation._id, (current) =>
      current.slot ? { unset: ['slot'], deadlineAt: null } : null
    )

    if (operation.type !== OPERATION_TYPES.REVERT) {
      await promoteWaiting(ctx, {
        environment: operation.environment,
        teamId: operation.teamId
      })
    }
  }

  if (operation.parentId) {
    await settleParent(ctx, operation)
  }
}
