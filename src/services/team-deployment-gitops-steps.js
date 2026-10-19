import { ObjectId } from 'mongodb'

import {
  CHECKS_FAILED,
  SYSTEM_ACTOR,
  auditDeployment
} from '#/services/team-deployment-entries.js'

// The one-off GitOps steps the backend dispatches for an entry - the D14
// retry apply, the D14 revert and the abandon of a failed pull request -
// each claimed first, so concurrent polls (a member's page and the sweep, or
// two instances) dispatch it once. A claim records `claimedAt` and, once
// dispatched, `dispatchedAt`; one never dispatched is claimable again after
// its lease, so a poll that stopped between the two cannot strand it.

const D14_FAILURE_REASONS = {
  reverted:
    'The apply failed again after a fresh retry, so the change is being reverted',
  unattributed:
    'The apply failed again after a fresh retry and platform engineers have been alerted'
}

function slugOf(path) {
  return /\/([^/]+)\.json$/.exec(path ?? '')?.[1] ?? null
}

function now() {
  return new Date().toISOString()
}

/**
 * Query on one `deployments[]` element for a claim at `field` nothing holds:
 * never claimed, released after a failed dispatch, or claimed but not
 * dispatched within the lease.
 * @param {string} field - e.g. `gitops.revert`
 * @param {number} leaseMs
 * @returns {object}
 */
export function claimableFieldQuery(field, leaseMs) {
  return {
    [`${field}.dispatchedAt`]: null,
    $or: [
      { [`${field}.claimedAt`]: null },
      {
        [`${field}.claimedAt`]: {
          $lte: new Date(Date.now() - leaseMs).toISOString()
        }
      }
    ]
  }
}

/**
 * Query on one `deployments[]` element for a GitOps step nothing holds (see
 * `claimableFieldQuery`).
 * @param {'applyRetry'|'revert'|'abandon'} step
 * @param {number} leaseMs
 * @returns {object}
 */
export function claimableQuery(step, leaseMs) {
  return claimableFieldQuery(`gitops.${step}`, leaseMs)
}

function isClaimable(step, leaseMs) {
  return (
    !step?.dispatchedAt &&
    (!step?.claimedAt || Date.parse(step.claimedAt) <= Date.now() - leaseMs)
  )
}

// Claims the step for this poll. False if another poll holds it.
async function claimGitopsStep(db, doc, entry, step, value, leaseMs) {
  const { modifiedCount } = await db.collection('teamDeployments').updateOne(
    {
      _id: doc._id,
      deployments: {
        $elemMatch: {
          id: entry.id,
          status: entry.status,
          ...claimableQuery(step, leaseMs)
        }
      }
    },
    { $set: { [`deployments.$.gitops.${step}`]: value } }
  )

  return modifiedCount === 1
}

/**
 * Records the outcome of a claimed step - unless its lease ran out and
 * another poll has claimed the step since.
 * @param {import('mongodb').Db} db
 * @param {{_id: import('mongodb').ObjectId}} doc
 * @param {{id: string}} entry
 * @param {'applyRetry'|'revert'|'abandon'} step
 * @param {{claimedAt: string}} claim
 * @param {object} value
 */
export async function settleGitopsStep(db, doc, entry, step, claim, value) {
  await db.collection('teamDeployments').updateOne(
    {
      _id: doc._id,
      deployments: {
        $elemMatch: {
          id: entry.id,
          [`gitops.${step}.claimedAt`]: claim.claimedAt
        }
      }
    },
    { $set: { [`deployments.$.gitops.${step}`]: value } }
  )
}

// A claim whose dispatch failed, free for the next poll. It keeps a
// revert's operation ID, so that poll submits the same operation.
function released(claim) {
  return { ...claim, claimedAt: null }
}

/**
 * Whether a failed operation still has its pull request to abandon (R7).
 * @param {object} entry
 * @param {number} leaseMs
 * @returns {boolean}
 */
export function needsAbandon(entry, leaseMs) {
  return (
    entry.status === CHECKS_FAILED &&
    Boolean(entry.gitops?.pullRequestNumber) &&
    isClaimable(entry.gitops.abandon, leaseMs)
  )
}

/**
 * Closes a failed operation's pull request and deletes its branch through
 * `submit`'s `abandon`, releasing the team file (R7). The abandon is then
 * followed to its end like any operation; a dispatch that fails releases
 * the claim so the sweep tries again.
 * @param {import('mongodb').Db} db
 * @param {object} doc
 * @param {object} entry
 * @param {{orchestrator: import('#/adapters/tenant-orchestrator.js').TenantOrchestrator, logger?: import('pino').Logger, claimLeaseMs: number}} deps
 */
export async function abandonOperation(
  db,
  doc,
  entry,
  { orchestrator, logger, claimLeaseMs }
) {
  const claim = { claimedAt: now() }

  if (
    !(await claimGitopsStep(db, doc, entry, 'abandon', claim, claimLeaseMs))
  ) {
    return
  }

  try {
    const submitted = await orchestrator.requestDeployment({
      environment: doc.environment,
      path: entry.gitops.path,
      document: null,
      operationId: entry.operationId,
      requestedBy: SYSTEM_ACTOR,
      expectedRevision: entry.gitops.expectedRevision ?? 0,
      action: 'abandon'
    })

    await settleGitopsStep(db, doc, entry, 'abandon', claim, {
      ...claim,
      action: 'abandon',
      submitRunId: submitted.submitRunId,
      submitRunUrl: submitted.submitRunUrl,
      dispatchedAt: now(),
      status: 'requested'
    })
    await auditDeployment(db, entry, { action: 'teamDeployment.abandon' })
  } catch (error) {
    await settleGitopsStep(db, doc, entry, 'abandon', claim, released(claim))
    logger?.error(
      { code: error.code ?? null, operationId: entry.operationId },
      'Abandon could not be submitted, retrying on the next sweep'
    )
  }
}

// Claims and dispatches the one fresh apply D14 allows. False if another
// poll holds the claim.
async function dispatchRetry(
  db,
  doc,
  entry,
  { orchestrator, logger, claimLeaseMs }
) {
  const claim = { claimedAt: now(), reason: 'd14-retry' }

  if (
    !(await claimGitopsStep(db, doc, entry, 'applyRetry', claim, claimLeaseMs))
  ) {
    return false
  }

  try {
    const run = await orchestrator.requestApply({
      environment: doc.environment,
      reason: `retry ${entry.operationId}`
    })

    await settleGitopsStep(db, doc, entry, 'applyRetry', claim, {
      ...claim,
      dispatchedAt: now(),
      ...run
    })
    await auditDeployment(db, entry, {
      action: 'teamDeployment.retry',
      code: 'd14-retry'
    })
  } catch (error) {
    await settleGitopsStep(db, doc, entry, 'applyRetry', claim, released(claim))
    logger?.error(
      { code: error.code ?? null, operationId: entry.operationId },
      'D14 retry apply could not be dispatched, retrying on the next poll'
    )
  }

  return true
}

/**
 * D14: submits the previous revision of the team file as a system
 * operation (`write` of the old document with a new revision, or `remove`
 * when the file is new). Returns false if it could not be submitted, so a
 * later poll tries again. A revert claimed again keeps its operation ID and
 * timestamp, so `submit` reports the same operation (`existing`) rather
 * than starting a second one.
 */
async function submitRevert(
  db,
  doc,
  entry,
  mergeSha,
  { orchestrator, logger, claimLeaseMs }
) {
  const earlier = entry.gitops.revert
  const claim = {
    operationId: earlier?.operationId ?? new ObjectId().toString(),
    requestedAt: earlier?.requestedAt ?? now(),
    action: null,
    claimedAt: now()
  }
  const { operationId, requestedAt } = claim

  if (!(await claimGitopsStep(db, doc, entry, 'revert', claim, claimLeaseMs))) {
    return false
  }

  try {
    const { path, revision = 0 } = entry.gitops
    const { document: previous } = await orchestrator.getPreviousDocument({
      path,
      mergeSha
    })
    const action = previous ? 'write' : 'remove'
    const submitted = await orchestrator.requestDeployment({
      environment: doc.environment,
      path,
      document: previous
        ? {
            ...previous,
            revision: revision + 1,
            operationId,
            updatedAt: requestedAt,
            updatedBy: SYSTEM_ACTOR
          }
        : null,
      operationId,
      requestedBy: SYSTEM_ACTOR,
      expectedRevision: revision,
      action
    })

    await settleGitopsStep(db, doc, entry, 'revert', claim, {
      ...claim,
      action,
      submitRunId: submitted.submitRunId,
      submitRunUrl: submitted.submitRunUrl,
      dispatchedAt: now(),
      status: 'requested'
    })
    await auditDeployment(db, entry, {
      action: 'teamDeployment.revert',
      code: action,
      reason: `revert operation ${operationId}`
    })

    return true
  } catch (error) {
    await settleGitopsStep(db, doc, entry, 'revert', claim, released(claim))
    logger?.error(
      { code: error.code ?? null, operationId: entry.operationId },
      'D14 revert could not be submitted, retrying on the next poll'
    )

    return false
  }
}

// The apply after the retry failed too: revert this team's change when the
// run report attributes the failure to it, alert engineers when it could
// attribute nothing, otherwise wait for the attributed teams' reverts.
async function failedAfterRetryPolicy(db, doc, entry, result, waiting, deps) {
  const { failingTeams, unattributedFailure } = result.failure

  if (failingTeams.includes(slugOf(entry.gitops.path))) {
    const mergeSha = result.mergeSha ?? entry.gitops.mergeSha
    // A revert already dispatched by a poll that stopped before persisting
    // this outcome is not submitted twice.
    const reverted =
      Boolean(entry.gitops.revert?.dispatchedAt) ||
      (await submitRevert(db, doc, entry, mergeSha, deps))

    return reverted
      ? { ...result, failureReason: D14_FAILURE_REASONS.reverted }
      : { ...waiting, status: entry.status }
  }

  if (unattributedFailure) {
    deps.logger?.error(
      { operationId: entry.operationId, environment: doc.environment },
      'Unattributed tenants apply failure needs a platform engineer'
    )
    await auditDeployment(db, entry, {
      action: 'teamDeployment.deployFailed',
      outcome: 'failure',
      code: 'unattributed-failure'
    })

    return { ...result, failureReason: D14_FAILURE_REASONS.unattributed }
  }

  return waiting
}

/**
 * The D14 failure policy (design C), applied when an apply that includes
 * this operation has failed: dispatch one fresh apply, never a re-run; if
 * the apply after it fails too, revert this team's change when the run
 * report attributes the failure to it, or alert engineers when nothing
 * could be attributed. A failure attributed only to other teams waits for
 * their revert. Returns the status to persist, or null when another poll
 * is already handling it.
 * @param {import('mongodb').Db} db
 * @param {object} doc
 * @param {object} entry
 * @param {import('#/adapters/tenant-orchestrator.js').DeploymentStatus} result
 * @param {{orchestrator: import('#/adapters/tenant-orchestrator.js').TenantOrchestrator, logger?: import('pino').Logger, claimLeaseMs: number}} deps
 * @returns {Promise<object|null>}
 */
export async function applyFailurePolicy(db, doc, entry, result, deps) {
  const retry = entry.gitops.applyRetry
  const waiting = { ...result, status: 'deploying', failure: null }

  // No retry yet, or one claimed whose dispatch never finished.
  if (!retry?.dispatchedAt) {
    return (await dispatchRetry(db, doc, entry, deps)) ? waiting : null
  }

  // The failure GitHub reports may still be the one before the retry. Run
  // IDs grow, so a failed run at or after the retry's is the retry or what
  // superseded it; an earlier run's failure, however late it is observed,
  // is not. Without run IDs, the time of observation decides.
  const failedAfterRetry =
    result.applyRunId != null && retry.runId != null
      ? result.applyRunId >= retry.runId
      : Date.parse(result.failure.observedAt) > Date.parse(retry.dispatchedAt)

  if (!failedAfterRetry) {
    return waiting
  }

  return failedAfterRetryPolicy(db, doc, entry, result, waiting, deps)
}
