import { isDeepStrictEqual } from 'node:util'

import { config } from '#/config.js'
import {
  tenantOrchestratorRegistry,
  GITHUB_ORCHESTRATOR
} from '#/adapters/tenant-orchestrator-registry.js'
import {
  CHECKS_FAILED,
  DEPLOY_FAILED,
  NON_TERMINAL_STATUSES,
  QUEUED,
  REMOVED,
  REMOVING,
  TERMINAL_FAILURE_STATUSES,
  auditDeployment,
  entryFilter,
  findEntry
} from '#/services/team-deployment-entries.js'
import {
  abandonOperation,
  applyFailurePolicy,
  claimableQuery,
  needsAbandon
} from '#/services/team-deployment-gitops-steps.js'
import { releaseQueue } from '#/services/team-deployment-queue.js'
import { teamDesiredStateBuilder } from '#/services/team-desired-state.js'

// The operations the backend submits after an entry's own - a D14 revert,
// an abandon, a team's removal of the model - each followed to its end
// through the same GitOps states.
const FOLLOW_UPS = ['revert', 'abandon', 'remove']

const REVERT_FAILED_REASON =
  'The apply failed again after a fresh retry and reverting the change failed too, so platform engineers have been alerted'
const REMOVE_FAILED_REASON =
  'The model could not be removed, so it is still deployed; platform engineers have been alerted'

function settingsOf({
  registry = tenantOrchestratorRegistry,
  logger,
  pollMinIntervalMs = config.get('gitops.pollMinIntervalMs'),
  claimLeaseMs = config.get('gitops.claimLeaseMs'),
  buildDesiredState = teamDesiredStateBuilder
}) {
  return {
    registry,
    logger,
    pollMinIntervalMs,
    claimLeaseMs,
    buildDesiredState
  }
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

// A follow-up dispatched and not yet at a terminal state.
function isTracked(followUp) {
  return (
    Boolean(followUp?.dispatchedAt) &&
    NON_TERMINAL_STATUSES.includes(followUp.status)
  )
}

function trackedFollowUp(entry) {
  return FOLLOW_UPS.find((step) => isTracked(entry.gitops?.[step]))
}

// What another, faster poll stored for the entry.
async function storedEntry(db, doc, entry) {
  const fresh = await db.collection('teamDeployments').findOne({ _id: doc._id })

  return findEntry(fresh, entry.id) ?? entry
}

// Reserves this poll's window before anything reads GitHub or ARM: moves
// `lastPolledAt` under `prefix` to now in one atomic update, unless another
// poll - a member's page, the sweep or another instance - did so within the
// minimum interval. Activation (`verified` -> `active`) reads nothing, so it
// needs no window.
async function reservePoll(db, doc, entry, { prefix, status, intervalMs }) {
  if (status === 'verified') {
    return true
  }

  const field = `${prefix}lastPolledAt`
  const { matchedCount } = await db.collection('teamDeployments').updateOne(
    {
      _id: doc._id,
      deployments: {
        $elemMatch: {
          id: entry.id,
          $or: [
            { [field]: null },
            {
              [field]: {
                $lte: new Date(Date.now() - intervalMs).toISOString()
              }
            }
          ]
        }
      }
    },
    { $set: { [`deployments.$.${field}`]: new Date().toISOString() } }
  )

  return matchedCount === 1
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

// The follow-up as an operation of its own, for the orchestrator to read
// through the same GitOps states.
function followUpOperation(doc, entry, step) {
  const followUp = entry.gitops[step]

  return {
    operationId: followUp.operationId ?? entry.operationId,
    status: followUp.status,
    environment: doc.environment,
    createdAt: followUp.dispatchedAt,
    gitops: { ...followUp, path: entry.gitops.path }
  }
}

// A follow-up's end is audited; a failure is also logged for an engineer
// and never retried. Logs carry operation IDs only, no personal data.
async function reportFollowUpEnd(db, doc, entry, step, logger) {
  const { operationId, status } = followUpOperation(doc, entry, step)
  const failed = TERMINAL_FAILURE_STATUSES.has(status)

  await auditDeployment(db, entry, {
    action: `teamDeployment.${step}${failed ? 'Failed' : 'Completed'}`,
    outcome: failed ? 'failure' : 'success',
    code: status,
    reason: `${step} operation ${operationId}`
  })

  if (failed) {
    logger?.error(
      {
        operationId: entry.operationId,
        followUpOperationId: operationId,
        environment: doc.environment,
        status
      },
      `The ${step} ended ${status} and needs a platform engineer`
    )
  }
}

// What a follow-up's end does to the entry itself: a failed revert leaves
// this team's failed change live, so the entry's failure reason says so; a
// removal that applied ends the entry as removed, one that failed puts the
// model back as active, still deployed.
function followUpEntryChanges(step, status) {
  if (step === 'revert' && TERMINAL_FAILURE_STATUSES.has(status)) {
    return { failureReason: REVERT_FAILED_REASON }
  }

  if (step === 'remove' && status === 'active') {
    return { status: REMOVED, removedAt: new Date().toISOString() }
  }

  if (step === 'remove' && TERMINAL_FAILURE_STATUSES.has(status)) {
    return { status: 'active', failureReason: REMOVE_FAILED_REASON }
  }

  return {}
}

// Persists a follow-up's status and trail with compare-and-set on the
// status read, then whatever its end means for the entry.
async function persistFollowUp(db, doc, entry, step, result, logger) {
  const followUp = entry.gitops[step]
  const changes = gitopsChangesOf(result, followUp)

  if (result.status !== followUp.status) {
    changes.status = result.status
  }

  const entryChanges = followUpEntryChanges(step, changes.status)

  if (Object.keys(changes).length === 0) {
    return entry
  }

  const update = {
    $set: {
      ...setFields(`gitops.${step}.`, changes),
      ...setFields('', entryChanges)
    }
  }

  if (entryChanges.status === REMOVED) {
    update.$pull = { 'gateway.allowedDeployments': entry.modelSlug }
  }

  const { matchedCount } = await db.collection('teamDeployments').updateOne(
    {
      _id: doc._id,
      deployments: {
        $elemMatch: { id: entry.id, [`gitops.${step}.status`]: followUp.status }
      }
    },
    update
  )

  if (matchedCount === 0) {
    return storedEntry(db, doc, entry)
  }

  const updated = {
    ...entry,
    ...entryChanges,
    gitops: { ...entry.gitops, [step]: { ...followUp, ...changes } }
  }

  if (changes.status && !isTracked(updated.gitops[step])) {
    await reportFollowUpEnd(db, doc, updated, step, logger)
  }

  if (entryChanges.status) {
    await auditTransition(db, entry, entryChanges.status)
  }

  return updated
}

// Polls a dispatched revert or abandon through its own submit run, pull
// request, merge and apply until it reaches a terminal state.
async function refreshFollowUp(db, doc, entry, step, settings) {
  const { registry, logger, pollMinIntervalMs } = settings
  const operation = followUpOperation(doc, entry, step)
  const reserved = await reservePoll(db, doc, entry, {
    prefix: `gitops.${step}.`,
    status: operation.status,
    intervalMs: pollMinIntervalMs
  })

  if (!reserved) {
    return storedEntry(db, doc, entry)
  }

  let result

  try {
    result = await registry.forEntry(entry).getDeploymentStatus(operation)
  } catch (error) {
    logger?.warn(
      { code: error.code ?? null, operationId: entry.operationId },
      `The ${step} status poll failed, keeping its last known status`
    )

    return entry
  }

  return persistFollowUp(db, doc, entry, step, result, logger)
}

// Polls the entry's own operation, applying the D14 policy to a failed
// apply and abandoning a pull request that failed its checks.
async function refreshOperation(db, doc, entry, settings) {
  const { registry, logger, pollMinIntervalMs, claimLeaseMs } = settings
  const reserved =
    !entry.gitops ||
    (await reservePoll(db, doc, entry, {
      prefix: 'gitops.',
      status: entry.status,
      intervalMs: pollMinIntervalMs
    }))

  if (!reserved) {
    return storedEntry(db, doc, entry)
  }

  const orchestrator = registry.forEntry(entry)
  const deps = { orchestrator, logger, claimLeaseMs }
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
    result = await applyFailurePolicy(db, doc, entry, result, deps)

    if (!result) {
      return entry
    }
  }

  const persisted = await persistStatus(db, doc, entry, result)

  if (persisted.transitioned && needsAbandon(persisted.entry, claimLeaseMs)) {
    await abandonOperation(db, doc, persisted.entry, deps)
  }

  return persisted.entry
}

// Whether polling the entry can move it on: its own operation, or a revert
// or abandon it led to, is still in progress.
function isInProgress(entry) {
  return (
    NON_TERMINAL_STATUSES.includes(entry.status) ||
    Boolean(trackedFollowUp(entry))
  )
}

async function refreshOwnStatus(db, doc, entry, settings) {
  if (
    entry.status === 'active' ||
    entry.status === REMOVING ||
    TERMINAL_FAILURE_STATUSES.has(entry.status)
  ) {
    const step = trackedFollowUp(entry)

    return step ? refreshFollowUp(db, doc, entry, step, settings) : entry
  }

  if (entry.status === REMOVED) {
    return entry
  }

  return refreshOperation(db, doc, entry, settings)
}

// A queued request moves when the operation holding its team file ends, so
// polling it polls the team's operations in progress first. Sequential by
// design: each may write back to the same document.
async function refreshQueued(db, doc, entry, settings) {
  for (const sibling of doc.deployments) {
    if (sibling.id !== entry.id && isInProgress(sibling)) {
      await refreshOwnStatus(db, doc, sibling, settings)
    }
  }

  return entry
}

/**
 * Advances one deployment entry's persisted status by asking the
 * orchestrator that submitted it for its current state, if it hasn't
 * already reached a terminal/active state - then any revert or abandon it
 * led to, until that ends. Each GitHub-mode poll first reserves its window
 * in Mongo, so concurrent polls read GitHub once per minimum interval. A
 * GitHub hiccup keeps the last known status rather than failing the caller.
 * When the team has requests queued behind the operation holding its team
 * file, the oldest is dispatched once nothing holds it.
 * @param {import('mongodb').Db} db
 * @param {object} doc
 * @param {object} entry
 * @param {{registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry, logger?: import('pino').Logger, pollMinIntervalMs?: number, claimLeaseMs?: number, buildDesiredState?: Function}} [deps] - `buildDesiredState` is the WS6 builder a queued GitHub-mode request is built with when dispatched
 */
export async function refreshEntryStatus(db, doc, entry, deps = {}) {
  const settings = settingsOf(deps)
  const queued = entry.status === QUEUED
  const refreshed = queued
    ? await refreshQueued(db, doc, entry, settings)
    : await refreshOwnStatus(db, doc, entry, settings)

  if (!doc.deployments?.some((deployment) => deployment.status === QUEUED)) {
    return refreshed
  }

  const dispatched = await releaseQueue(db, doc, settings)

  if (dispatched?.id === entry.id) {
    return dispatched
  }

  return queued ? storedEntry(db, doc, entry) : refreshed
}

const NOTHING_SWEPT = { polled: 0, transitioned: 0, abandoned: 0 }

// One GitHub-mode entry's turn in the sweep: claim its abandon, or poll it
// (or its revert or abandon) while in progress, or try to dispatch it while
// queued. Returns what it counted towards.
async function sweepEntry(db, doc, entry, settings) {
  const { registry, logger, claimLeaseMs } = settings

  if (needsAbandon(entry, claimLeaseMs)) {
    await abandonOperation(db, doc, entry, {
      orchestrator: registry.forEntry(entry),
      logger,
      claimLeaseMs
    })

    return { ...NOTHING_SWEPT, abandoned: 1 }
  }

  if (!isInProgress(entry) && entry.status !== QUEUED) {
    return NOTHING_SWEPT
  }

  const refreshed = await refreshEntryStatus(db, doc, entry, settings)

  return {
    ...NOTHING_SWEPT,
    polled: 1,
    transitioned: refreshed.status === entry.status ? 0 : 1
  }
}

/**
 * The maintenance sweep for GitHub-mode operations: polls every
 * non-terminal one (R11 - terminal operations are never polled; each poll
 * still honours the per-operation minimum interval), writing and auditing
 * each transition, follows every dispatched revert and abandon to its end,
 * claims an `abandon` nobody holds and dispatches a team's next queued
 * request once nothing holds its team file. Operations nobody is watching still
 * progress and reach `active`.
 * @param {import('mongodb').Db} db
 * @param {{registry?: object, logger?: import('pino').Logger, pollMinIntervalMs?: number, claimLeaseMs?: number, buildDesiredState?: Function}} [deps]
 * @returns {Promise<{polled: number, transitioned: number, abandoned: number}>}
 */
export async function sweepGitopsDeployments(db, deps = {}) {
  const settings = settingsOf(deps)
  const docs = await db
    .collection('teamDeployments')
    .find({
      deployments: {
        $elemMatch: {
          orchestrator: GITHUB_ORCHESTRATOR,
          $or: [
            { status: { $in: [...NON_TERMINAL_STATUSES, QUEUED] } },
            {
              status: CHECKS_FAILED,
              'gitops.pullRequestNumber': { $ne: null },
              ...claimableQuery('abandon', settings.claimLeaseMs)
            },
            ...FOLLOW_UPS.map((step) => ({
              [`gitops.${step}.dispatchedAt`]: { $ne: null },
              [`gitops.${step}.status`]: { $in: NON_TERMINAL_STATUSES }
            }))
          ]
        }
      }
    })
    .toArray()

  const totals = { ...NOTHING_SWEPT }

  // Sequential by design: each step may write back to the same document,
  // and entries share one document per team+environment.
  for (const doc of docs) {
    for (const entry of doc.deployments) {
      if (entry.orchestrator === GITHUB_ORCHESTRATOR) {
        const swept = await sweepEntry(db, doc, entry, settings)

        totals.polled += swept.polled
        totals.transitioned += swept.transitioned
        totals.abandoned += swept.abandoned
      }
    }
  }

  return totals
}
