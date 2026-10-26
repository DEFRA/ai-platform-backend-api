import { uuidv7 } from '#/common/helpers/uuid-v7.js'
import {
  buildOperation,
  canonicalDocument,
  newOutboxEntry
} from '#/operations/operation-factory.js'
import { FAILURE_CODES } from '#/operations/operation-projection.js'
import {
  findOperation,
  insertOperation,
  isDuplicateKey
} from '#/operations/operation-repository.js'
import {
  DEPLOY_FAILED,
  OPERATION_TYPES,
  heldDeadline
} from '#/operations/operation-state-machine.js'
import {
  writeOperation,
  writeWithRetry
} from '#/operations/operation-writer.js'
import { publish } from '#/operations/operations-support.js'
import { SYSTEM_ACTOR } from '#/services/team-deployment-entries.js'

// How many held periods the advisory pause flag is trusted for before the
// revert probes the pause itself.
const TRUSTED_PASSES = 1

// The revert of a failed write (plan 5). Each function takes the service's
// context ({db, settings, logger, relay, buildDocument, reader, controls}).

// The revert's document: the file before the operation's commit, as the
// next revision (plan 5, "Revert"); none when the file is new, so the
// revert removes it.
async function revertOf(reader, parent, id) {
  const { document: previous } = await reader.getPreviousDocument({
    path: parent.target.path,
    commitSha: parent.gitops.commitSha
  })
  const revision = parent.revision ?? 0
  const now = new Date().toISOString()

  return previous
    ? {
        action: 'revert',
        document: {
          ...previous,
          revision: revision + 1,
          operationId: id,
          updatedAt: now,
          updatedBy: SYSTEM_ACTOR
        }
      }
    : { action: 'remove', document: null }
}

function revertChildOf(parent, id, { action, document }, settings) {
  const child = buildOperation({
    type: OPERATION_TYPES.REVERT,
    state: 'requested',
    teamId: parent.teamId,
    environment: parent.environment,
    target: parent.target,
    items: [],
    parentId: parent._id,
    slot: 'revert',
    action,
    requestedBy: SYSTEM_ACTOR,
    requestedByUserId: SYSTEM_ACTOR,
    traceparent: parent.traceparent,
    cdpRequestId: parent.cdpRequestId
  })

  child._id = id
  Object.assign(child, {
    ...(document ? { document: canonicalDocument(document) } : {}),
    expectedRevision: parent.revision ?? 0,
    ...(parent.heldPasses ? { heldPasses: parent.heldPasses } : {}),
    outbox: [newOutboxEntry('submit', { attempt: 1 })],
    outboxPending: true,
    deadlineAt: new Date(
      Date.now() + settings.deadlines.requested
    ).toISOString()
  })

  return child
}

// A revert is only worth starting while its parent still holds the failure
// of the apply it reverts: not recovered, and no newer attempt running.
function isStillFailed(parent) {
  const newerAttempt =
    parent.lastFailure?.runId != null &&
    parent.gitops.applyRunId !== parent.lastFailure.runId

  return parent.state === DEPLOY_FAILED && !newerAttempt
}

async function cancelRevert(ctx, parentId) {
  await writeWithRetry(ctx, parentId, (current) =>
    current.deferred ? { unset: ['deferred', 'revertId'] } : null
  )
  ctx.logger?.warn(
    { operationId: parentId, code: FAILURE_CODES.REVERT_CANCELLED },
    'The revert was cancelled: the failed apply moved on'
  )
}

async function rearmRevert(ctx, parent) {
  const passes = (parent.heldPasses ?? 0) + 1

  await writeOperation(ctx, parent, {
    deadlineAt: heldDeadline(ctx.settings.deadlineHeldMs, passes),
    set: { heldPasses: passes }
  })
}

// The advisory pause flag is trusted once, for one held period: a `resumed`
// event can be lost, and the failed parent keeps its file while it waits. At
// the next deadline the revert is published and its own submit reads the
// pause the workflows hold (plan 5, "Pause"; AC25); it answers `paused`
// again if the pause stands.
async function holdsForPause(ctx, parent) {
  return (
    (parent.heldPasses ?? 0) < TRUSTED_PASSES &&
    ctx.controls.isPaused(parent.environment)
  )
}

// The claim on the still-failed parent, made before the child exists, so a
// child is never publishable for a parent that recovered or was retried
// while the file was read. It keeps the revert pending (`deferred`, due at
// the next sweep) until the child is published, so a stop in between is
// completed by the sweep.
function claimChange(ctx, id) {
  return (current) =>
    isStillFailed(current)
      ? {
          set: { revertId: id },
          deadlineAt: new Date(
            Date.now() + ctx.settings.sweepIntervalMs
          ).toISOString()
        }
      : null
}

async function insertChild(ctx, parent, id, revert) {
  try {
    await insertOperation(
      ctx.db,
      revertChildOf(parent, id, revert, ctx.settings)
    )
  } catch (error) {
    // Created by an earlier try that stopped before it finished.
    if (!isDuplicateKey(error)) {
      throw error
    }
  }
}

// The child is published; the parent no longer has a revert pending.
async function settleClaim(ctx, parentId, id) {
  await publish(ctx, id)
  await writeWithRetry(ctx, parentId, (current) =>
    current.revertId === id && current.deferred
      ? { unset: ['deferred'], deadlineAt: null }
      : null
  )
}

async function createRevert(ctx, parent, id) {
  const revert = await revertOf(ctx.reader, parent, id)
  const claimed = await writeWithRetry(ctx, parent._id, claimChange(ctx, id))

  if (!claimed) {
    await cancelRevert(ctx, parent._id)

    return 'cancelled'
  }

  await insertChild(ctx, claimed, id, revert)
  await settleClaim(ctx, parent._id, id)

  return 'started'
}

// A claimed revert a stop left unfinished: the child is published, or, when
// it was never created, built again under the same id while the parent
// still holds the failure.
async function completeClaim(ctx, parent) {
  const id = parent.revertId

  if (await findOperation(ctx.db, id)) {
    await settleClaim(ctx, parent._id, id)

    return 'started'
  }

  if (!isStillFailed(parent)) {
    await cancelRevert(ctx, parent._id)

    return 'cancelled'
  }

  return createRevert(ctx, parent, id)
}

/**
 * Starts the revert of a `deploy-failed` operation once its grace has
 * passed (plan 5): a child `team-file.revert`, built now. The parent is
 * claimed (`revertId`) while it is still `deploy-failed` with no newer apply
 * attempt running, and only then is the child created and published, so a
 * parent that recovers or is retried during the read of GitHub never has
 * its stale rollback published. A claim a stop left unfinished is completed
 * on the next call. While the environment is paused the revert is re-armed
 * once, then published at the held deadline (its submit reads the pause
 * itself); otherwise it is cancelled. The child takes no slot of the file;
 * the parent keeps its, and the child carries on the parent's backoff.
 * @param {object} ctx
 * @param {object} parent
 * @returns {Promise<'started'|'cancelled'|'re-armed'>}
 */
export async function startRevert(ctx, parent) {
  if (parent.revertId) {
    return completeClaim(ctx, parent)
  }

  if (!isStillFailed(parent)) {
    await cancelRevert(ctx, parent._id)

    return 'cancelled'
  }

  if (await holdsForPause(ctx, parent)) {
    await rearmRevert(ctx, parent)

    return 're-armed'
  }

  return createRevert(ctx, parent, uuidv7())
}
