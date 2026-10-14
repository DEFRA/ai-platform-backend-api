import { isDeepStrictEqual } from 'node:util'

import { ObjectId } from 'mongodb'

import {
  tenantOrchestratorRegistry,
  GITHUB_ORCHESTRATOR
} from '#/adapters/tenant-orchestrator-registry.js'
import {
  CHECKS_FAILED,
  DEPLOY_FAILED,
  SYSTEM_ACTOR,
  TERMINAL_FAILURE_STATUSES,
  auditDeployment,
  entryFilter,
  findEntry
} from '#/services/team-deployment-entries.js'

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

const D14_FAILURE_REASONS = {
  reverted:
    'The apply failed again after a fresh retry, so the change is being reverted',
  unattributed:
    'The apply failed again after a fresh retry and platform engineers have been alerted'
}

function slugOf(path) {
  return /\/([^/]+)\.json$/.exec(path ?? '')?.[1] ?? null
}

// `fields` as a `$set` on the matched entry, each key under `prefix`.
function setFields(prefix, fields) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      `deployments.$.${prefix}${key}`,
      value
    ])
  )
}

// The entry fields a status result changes: its status and, on reaching it,
// when it became active or why it failed.
function statusChangesOf(result, entry) {
  if (result.status === entry.status) {
    return {}
  }

  const update = { status: result.status }

  if (result.status === 'active') {
    update.activatedAt = new Date().toISOString()
  }

  if (TERMINAL_FAILURE_STATUSES.has(result.status)) {
    update.failureReason = result.failureReason ?? 'unknown'
  }

  return update
}

// The GitOps trail fields a status result carries that differ from what is
// stored on `gitops` - so a poll inside the minimum interval, which reads
// nothing new, writes nothing either.
function gitopsChangesOf(result, gitops) {
  return Object.fromEntries(
    Object.entries({
      submitRunUrl: result.links?.submitRun,
      pullRequestNumber: result.pullRequestNumber,
      pullRequestUrl: result.links?.pullRequest,
      mergeSha: result.mergeSha,
      mergedAt: result.mergedAt,
      applyRunId: result.applyRunId,
      applyRunUrl: result.links?.applyRun,
      appliedSha: result.appliedSha,
      resources: result.resources,
      lastPolledAt: result.polledAt
    }).filter(
      ([key, value]) =>
        value !== undefined && !isDeepStrictEqual(gitops[key], value)
    )
  )
}

async function setGitopsStep(db, doc, entry, step, value) {
  await db
    .collection('teamDeployments')
    .updateOne(
      { _id: doc._id, 'deployments.id': entry.id },
      { $set: { [`deployments.$.gitops.${step}`]: value } }
    )
}

// Claims a one-off GitOps side effect (retry, revert, abandon) for this
// entry, so concurrent polls - a member's page and the sweep, or two
// instances - dispatch it once. Returns false if another poll got there.
async function claimGitopsStep(db, doc, entry, step, value) {
  const { modifiedCount } = await db.collection('teamDeployments').updateOne(
    {
      _id: doc._id,
      deployments: {
        $elemMatch: {
          id: entry.id,
          status: entry.status,
          [`gitops.${step}`]: null
        }
      }
    },
    { $set: { [`deployments.$.gitops.${step}`]: value } }
  )

  return modifiedCount === 1
}

// What another, faster poll stored for the entry.
async function storedEntry(db, doc, entry) {
  const fresh = await db.collection('teamDeployments').findOne({ _id: doc._id })

  return findEntry(fresh, entry.id) ?? entry
}

async function auditTransition(db, entry, status) {
  await auditDeployment(db, entry, {
    action: 'teamDeployment.transition',
    outcome: TERMINAL_FAILURE_STATUSES.has(status) ? 'failure' : 'success',
    code: status,
    reason: `${entry.status} -> ${status}`
  })
}

/**
 * Persists a status result with compare-and-set on the entry's id and the
 * status read, so a slower concurrent poll never overwrites a newer status
 * with its stale one, and audits a transition once. Reaching `active` adds
 * the model to the team's `gateway.allowedDeployments`.
 */
async function persistStatus(db, doc, entry, result) {
  const update = statusChangesOf(result, entry)
  const gitopsUpdate = entry.gitops ? gitopsChangesOf(result, entry.gitops) : {}

  if (
    Object.keys(update).length === 0 &&
    Object.keys(gitopsUpdate).length === 0
  ) {
    return { entry, transitioned: false }
  }

  const updateOps = {
    $set: { ...setFields('', update), ...setFields('gitops.', gitopsUpdate) }
  }

  if (update.status === 'active') {
    updateOps.$addToSet = { 'gateway.allowedDeployments': entry.modelSlug }
  }

  const { matchedCount } = await db
    .collection('teamDeployments')
    .updateOne(entryFilter(doc, entry), updateOps)

  if (matchedCount === 0) {
    return { entry: await storedEntry(db, doc, entry), transitioned: false }
  }

  if (update.status) {
    await auditTransition(db, entry, update.status)
  }

  return {
    entry: {
      ...entry,
      ...update,
      gitops: entry.gitops ? { ...entry.gitops, ...gitopsUpdate } : null
    },
    transitioned: Boolean(update.status)
  }
}

/**
 * D14: submits the previous revision of the team file as a system
 * operation (`write` of the old document with a new revision, or `remove`
 * when the file is new). Returns false if it could not be submitted, so a
 * later poll tries again.
 */
async function submitRevert(
  db,
  doc,
  entry,
  mergeSha,
  { orchestrator, logger }
) {
  const operationId = new ObjectId().toString()
  const requestedAt = new Date().toISOString()
  const claim = { operationId, requestedAt, action: null }

  if (!(await claimGitopsStep(db, doc, entry, 'revert', claim))) {
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

    await setGitopsStep(db, doc, entry, 'revert', {
      ...claim,
      action,
      submitRunId: submitted.submitRunId,
      submitRunUrl: submitted.submitRunUrl
    })
    await auditDeployment(db, entry, {
      action: 'teamDeployment.revert',
      code: action,
      reason: `revert operation ${operationId}`
    })

    return true
  } catch (error) {
    await setGitopsStep(db, doc, entry, 'revert', null)
    logger?.error(
      { code: error.code ?? null, operationId: entry.operationId },
      'D14 revert could not be submitted, retrying on the next poll'
    )

    return false
  }
}

/**
 * The D14 failure policy (design C), applied when an apply that includes
 * this operation has failed: dispatch one fresh apply, never a re-run; if
 * the apply after it fails too, revert this team's change when the run
 * report attributes the failure to it, or alert engineers when nothing
 * could be attributed. A failure attributed only to other teams waits for
 * their revert. Returns the status to persist, or null when another poll
 * is already handling it.
 */
async function applyFailurePolicy(db, doc, entry, result, deps) {
  const { orchestrator, logger } = deps
  const retry = entry.gitops.applyRetry
  const waiting = { ...result, status: 'deploying', failure: null }

  if (!retry) {
    const dispatchedAt = new Date().toISOString()
    const claim = { dispatchedAt, reason: 'd14-retry' }

    if (!(await claimGitopsStep(db, doc, entry, 'applyRetry', claim))) {
      return null
    }

    try {
      const run = await orchestrator.requestApply({
        environment: doc.environment,
        reason: `retry ${entry.operationId}`
      })

      await setGitopsStep(db, doc, entry, 'applyRetry', { ...claim, ...run })
      await auditDeployment(db, entry, {
        action: 'teamDeployment.retry',
        code: 'd14-retry'
      })
    } catch (error) {
      await setGitopsStep(db, doc, entry, 'applyRetry', null)
      logger?.error(
        { code: error.code ?? null, operationId: entry.operationId },
        'D14 retry apply could not be dispatched, retrying on the next poll'
      )
    }

    return waiting
  }

  // The failure GitHub reports may still be the one before the retry.
  const failedAfterRetry =
    Date.parse(result.failure.observedAt) > Date.parse(retry.dispatchedAt)

  if (!failedAfterRetry) {
    return waiting
  }

  const { failingTeams, unattributedFailure } = result.failure

  if (failingTeams.includes(slugOf(entry.gitops.path))) {
    const mergeSha = result.mergeSha ?? entry.gitops.mergeSha
    const reverted = await submitRevert(db, doc, entry, mergeSha, deps)

    return reverted
      ? { ...result, failureReason: D14_FAILURE_REASONS.reverted }
      : { ...waiting, status: entry.status }
  }

  if (unattributedFailure) {
    logger?.error(
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
 * Closes a failed operation's pull request and deletes its branch through
 * `submit`'s `abandon`, releasing the team file (R7). Clears its claim on
 * failure so the sweep tries again.
 */
async function abandonOperation(db, doc, entry, { orchestrator, logger }) {
  const claim = { requestedAt: new Date().toISOString() }

  if (!(await claimGitopsStep(db, doc, entry, 'abandon', claim))) {
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

    await setGitopsStep(db, doc, entry, 'abandon', {
      ...claim,
      submitRunId: submitted.submitRunId,
      submitRunUrl: submitted.submitRunUrl
    })
    await auditDeployment(db, entry, { action: 'teamDeployment.abandon' })
  } catch (error) {
    await setGitopsStep(db, doc, entry, 'abandon', null)
    logger?.error(
      { code: error.code ?? null, operationId: entry.operationId },
      'Abandon could not be submitted, retrying on the next sweep'
    )
  }
}

function needsAbandon(entry) {
  return (
    entry.status === CHECKS_FAILED &&
    Boolean(entry.gitops?.pullRequestNumber) &&
    !entry.gitops.abandon
  )
}

/**
 * Advances one deployment entry's persisted status by asking the
 * orchestrator that submitted it for its current state, if it hasn't
 * already reached a terminal/active state. A GitHub hiccup keeps the last
 * known status rather than failing the caller.
 * @param {import('mongodb').Db} db
 * @param {object} doc
 * @param {object} entry
 * @param {{registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry, logger?: import('pino').Logger}} [deps]
 */
export async function refreshEntryStatus(
  db,
  doc,
  entry,
  { registry = tenantOrchestratorRegistry, logger } = {}
) {
  if (
    entry.status === 'active' ||
    TERMINAL_FAILURE_STATUSES.has(entry.status)
  ) {
    return entry
  }

  const orchestrator = registry.forEntry(entry)
  let result

  try {
    result = await orchestrator.getDeploymentStatus({
      ...entry,
      environment: doc.environment
    })
  } catch (error) {
    logger?.warn(
      { code: error.code ?? null, operationId: entry.operationId },
      'Team deployment status poll failed, keeping the last known status'
    )

    return entry
  }

  if (result.status === DEPLOY_FAILED && result.failure && entry.gitops) {
    result = await applyFailurePolicy(db, doc, entry, result, {
      orchestrator,
      logger
    })

    if (!result) {
      return entry
    }
  }

  const persisted = await persistStatus(db, doc, entry, result)

  if (persisted.transitioned && needsAbandon(persisted.entry)) {
    await abandonOperation(db, doc, persisted.entry, { orchestrator, logger })
  }

  return persisted.entry
}

// One GitHub-mode entry's turn in the sweep: retry its abandon, or poll it
// while it is still in progress. Returns what it counted towards.
async function sweepEntry(db, doc, entry, deps) {
  const { registry = tenantOrchestratorRegistry, logger } = deps

  if (needsAbandon(entry)) {
    await abandonOperation(db, doc, entry, {
      orchestrator: registry.forEntry(entry),
      logger
    })

    return { polled: 0, transitioned: 0, abandoned: 1 }
  }

  if (!NON_TERMINAL_STATUSES.includes(entry.status)) {
    return { polled: 0, transitioned: 0, abandoned: 0 }
  }

  const refreshed = await refreshEntryStatus(db, doc, entry, deps)

  return {
    polled: 1,
    transitioned: refreshed.status === entry.status ? 0 : 1,
    abandoned: 0
  }
}

/**
 * The maintenance sweep for GitHub-mode operations: polls every
 * non-terminal one (R11 - terminal operations are never polled; each poll
 * still honours the per-operation minimum interval), writing and auditing
 * each transition, and retries an `abandon` that could not be submitted.
 * Operations nobody is watching still progress and reach `active`.
 * @param {import('mongodb').Db} db
 * @param {{registry?: object, logger?: import('pino').Logger}} [deps]
 * @returns {Promise<{polled: number, transitioned: number, abandoned: number}>}
 */
export async function sweepGitopsDeployments(db, deps = {}) {
  const docs = await db
    .collection('teamDeployments')
    .find({
      deployments: {
        $elemMatch: {
          orchestrator: GITHUB_ORCHESTRATOR,
          $or: [
            { status: { $in: NON_TERMINAL_STATUSES } },
            {
              status: CHECKS_FAILED,
              'gitops.pullRequestNumber': { $ne: null },
              'gitops.abandon': null
            }
          ]
        }
      }
    })
    .toArray()

  const totals = { polled: 0, transitioned: 0, abandoned: 0 }

  // Sequential by design: each step may write back to the same document,
  // and entries share one document per team+environment.
  for (const doc of docs) {
    for (const entry of doc.deployments) {
      if (entry.orchestrator === GITHUB_ORCHESTRATOR) {
        const swept = await sweepEntry(db, doc, entry, deps)

        totals.polled += swept.polled
        totals.transitioned += swept.transitioned
        totals.abandoned += swept.abandoned
      }
    }
  }

  return totals
}
