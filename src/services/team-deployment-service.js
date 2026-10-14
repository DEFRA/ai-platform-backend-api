import { isDeepStrictEqual } from 'node:util'

import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { findModelBySlug } from '#/services/models-service.js'
import {
  tenantOrchestratorRegistry,
  GITHUB_ORCHESTRATOR
} from '#/adapters/tenant-orchestrator-registry.js'
import { recordAuditEvent } from '#/services/audit-service.js'
import { requirePlatformAdmin } from '#/services/user-service.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'

const TERMINAL_FAILURE_STATUSES = ['checks-failed', 'deploy-failed']

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

// Opaque ID the backend submits its own GitOps operations (D14 reverts,
// abandons) as, in place of a user.
const SYSTEM_ACTOR = 'ai-platform-backend'

const W3C_TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

// Phase 1 (confirmed 24 Sept 2026): the one live team-facing environment is
// the Sandbox (SND4) - Infradev (SND1) is platform-internal/synthetic, not
// team-facing, so it is a valid schema value but never policy-allowed here.
const TEAM_FACING_ENVIRONMENT = 'sandbox'

// User-facing progress steps for the "being set up" wait page - the mapping
// from design C's real GitOps states (never shown to the user directly) to
// these four friendly, fixed labels is a business rule, so it lives here
// rather than being guessed at again in the frontend.
const PROGRESS_STEP_LABELS = [
  'Request recorded',
  'Team checked',
  'Setting up access in Azure',
  'Creating your key'
]

const PROGRESS_STEP_INDEX_BY_STATUS = {
  requested: 0,
  'pr-raised': 1,
  merged: 2,
  deploying: 2,
  deployed: 2,
  verified: 3,
  active: 3
}

const D14_FAILURE_REASONS = {
  reverted:
    'The apply failed again after a fresh retry, so the change is being reverted',
  unattributed:
    'The apply failed again after a fresh retry and platform engineers have been alerted'
}

/**
 * Builds the four fixed-label progress steps shown on the team-request wait
 * page, marking each `done`/`current`/`pending` relative to the deployment's
 * current raw status. Returns `null` for a terminal failure status - the
 * frontend shows its own failure messaging instead of a step list there.
 * @param {string} status
 */
function buildProgressSteps(status) {
  if (TERMINAL_FAILURE_STATUSES.includes(status)) {
    return null
  }

  const currentIndex = PROGRESS_STEP_INDEX_BY_STATUS[status] ?? 0

  return PROGRESS_STEP_LABELS.map((label, index) => ({
    label,
    state:
      index < currentIndex
        ? 'done'
        : index === currentIndex
          ? 'current'
          : 'pending'
  }))
}

// Links to the GitHub runs and pull request behind a GitOps operation, for
// support; only those that exist yet.
function linksOf(gitops) {
  return Object.fromEntries(
    Object.entries({
      submitRun: gitops?.submitRunUrl,
      pullRequest: gitops?.pullRequestUrl,
      applyRun: gitops?.applyRunUrl
    }).filter(([, url]) => url)
  )
}

/**
 * Maps a `teamDeployments` document + one of its `deployments[]` entries to
 * the flat shape routes/frontend already expect (an `_id` per deployment,
 * as if it still had its own document).
 * @param {{teamId: string, environment: string}} doc
 * @param {object} entry
 */
function toDeploymentView(doc, entry) {
  return {
    _id: entry.id,
    teamId: doc.teamId,
    environment: doc.environment,
    modelSlug: entry.modelSlug,
    status: entry.status,
    progressSteps: buildProgressSteps(entry.status),
    operationId: entry.operationId,
    requestedBy: entry.requestedBy,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt,
    activatedAt: entry.activatedAt,
    failureReason: entry.failureReason,
    links: linksOf(entry.gitops)
  }
}

function findEntry(doc, id) {
  return doc?.deployments?.find((deployment) => deployment.id === id)
}

function slugOf(path) {
  return /\/([^/]+)\.json$/.exec(path ?? '')?.[1] ?? null
}

async function auditDeployment(
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

/**
 * The WS6 seam: the GitHub orchestrator submits a whole desired-state
 * document, which only the Teams developer's builder (with the team's
 * immutable `slug`) can produce. Until it is supplied, GitHub-mode requests
 * fail with `501 desired-state-unavailable`; the mock needs no document.
 * @param {(db: import('mongodb').Db, params: {teamId: string, environment: string, modelSlug: string, operationId: string, requestedBy: string}) => Promise<{document: object, expectedRevision: number}|null>} [buildDesiredState]
 * @param {import('mongodb').Db} db
 * @param {object} params
 */
async function buildSubmission(buildDesiredState, db, params) {
  const desired = buildDesiredState ? await buildDesiredState(db, params) : null
  const slug = desired?.document?.team?.slug

  if (!slug) {
    throw boomWithCode(
      Boom.notImplemented,
      'The desired-state document for this team cannot be built yet',
      'desired-state-unavailable'
    )
  }

  return {
    path: `environments/${params.environment}/${slug}.json`,
    document: desired.document,
    expectedRevision: desired.expectedRevision ?? 0
  }
}

/**
 * Requests provisioning of a team's dedicated model deployment (B09). One
 * document per team per environment holds every model the team has
 * requested there, mirroring design C's `environments/{env}/{team}.json`
 * shape (`gateway.allowedDeployments` etc.) - requesting a second model for
 * a team that already has a document for this environment extends it,
 * rather than creating a sibling document. Only `sandbox` is policy-allowed
 * today, even though the schema accepts every design C environment - future
 * environments are a policy change, not a schema change. Each entry records
 * the orchestrator that submitted it and, for GitHub, its GitOps trail
 * (`gitops`: path, branch, runs, pull request, SHAs, resources).
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, modelSlug: string, environment: string, requestedBy: string, idempotencyKey: string, traceParent?: string}} params
 * @param {{registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry, buildDesiredState?: Function}} [deps]
 */
export async function requestDeployment(
  db,
  locker,
  { teamId, modelSlug, environment, requestedBy, idempotencyKey, traceParent },
  { registry = tenantOrchestratorRegistry, buildDesiredState } = {}
) {
  if (environment !== TEAM_FACING_ENVIRONMENT) {
    throw boomWithCode(
      Boom.forbidden,
      'This environment is not available yet',
      'environment-not-available'
    )
  }

  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId: requestedBy, status: 'active' })

  if (!membership) {
    throw Boom.notFound()
  }

  const model = await findModelBySlug(db, modelSlug)

  if (
    !model ||
    !model.eligible ||
    !model.tiers?.includes('team') ||
    !model.environments?.includes(environment)
  ) {
    throw boomWithCode(
      Boom.forbidden,
      'Model is not eligible for this environment',
      'model-not-eligible'
    )
  }

  // Several models can now be requested for the same team+environment
  // document, so a plain unique index can no longer detect an
  // idempotency-key replay or a duplicate model by itself - every mutation
  // of the document is serialised behind this lock instead.
  const lock = await acquireLockWithRetry(
    locker,
    `team-deployment:${teamId}:${environment}`
  )

  try {
    const doc = await db
      .collection('teamDeployments')
      .findOne({ teamId, environment })

    const replay = doc?.deployments?.find(
      (deployment) => deployment.idempotencyKey === idempotencyKey
    )

    if (replay) {
      return toDeploymentView(doc, replay)
    }

    const conflicting = doc?.deployments?.find(
      (deployment) => deployment.modelSlug === modelSlug
    )

    if (conflicting) {
      throw boomWithCode(
        Boom.conflict,
        'A deployment already exists for this team and model',
        'deployment-exists',
        { existingId: conflicting.id }
      )
    }

    const operationId = new ObjectId().toString()
    const isGithub = registry.key === GITHUB_ORCHESTRATOR
    const submission = isGithub
      ? await buildSubmission(buildDesiredState, db, {
          teamId,
          environment,
          modelSlug,
          operationId,
          requestedBy
        })
      : { path: null, document: null, expectedRevision: 0 }

    const now = new Date().toISOString()
    const entry = {
      id: new ObjectId().toString(),
      modelSlug,
      status: 'requested',
      operationId,
      requestedBy,
      idempotencyKey,
      createdAt: now,
      activatedAt: null,
      failureReason: null,
      orchestrator: registry.key,
      gitops: isGithub
        ? {
            path: submission.path,
            branch: `op/${operationId}`,
            action: 'write',
            revision: submission.document.revision ?? null,
            expectedRevision: submission.expectedRevision,
            submitRunId: null,
            submitRunUrl: null
          }
        : null
    }

    await db.collection('teamDeployments').updateOne(
      { teamId, environment },
      {
        $push: { deployments: entry },
        $setOnInsert: {
          teamId,
          environment,
          gateway: {
            credentialType: null,
            allowedDeployments: [],
            limits: {}
          },
          oauthClient: { enabled: false, appRoles: [] },
          createdAt: now
        },
        $set: { updatedAt: now }
      },
      { upsert: true }
    )

    let submitted

    try {
      submitted = await registry.orchestrator.requestDeployment({
        environment,
        path: submission.path,
        document: submission.document,
        operationId,
        requestedBy,
        expectedRevision: submission.expectedRevision,
        action: 'write',
        traceParent: W3C_TRACEPARENT.test(traceParent ?? '')
          ? traceParent
          : undefined
      })
    } catch (error) {
      const code =
        error.code === 'desired-state-too-large'
          ? 'desired-state-too-large'
          : 'upstream-unavailable'

      // Pull the entry so a retry can start cleanly - it never reached the
      // orchestrator, so nothing needs unwinding on that side either.
      await db
        .collection('teamDeployments')
        .updateOne(
          { teamId, environment },
          { $pull: { deployments: { id: entry.id } } }
        )
      await auditDeployment(db, entry, {
        action: 'teamDeployment.request',
        actorUserId: requestedBy,
        outcome: 'failure',
        code
      })

      throw code === 'desired-state-too-large'
        ? boomWithCode(
            Boom.badData,
            'The desired-state document is too large to submit',
            code
          )
        : boomWithCode(
            Boom.badGateway,
            'Failed to request the team deployment',
            code
          )
    }

    if (entry.gitops) {
      entry.gitops.submitRunId = submitted.submitRunId
      entry.gitops.submitRunUrl = submitted.submitRunUrl

      await db.collection('teamDeployments').updateOne(
        { teamId, environment, 'deployments.id': entry.id },
        {
          $set: {
            'deployments.$.gitops.submitRunId': submitted.submitRunId,
            'deployments.$.gitops.submitRunUrl': submitted.submitRunUrl
          }
        }
      )
    }

    await auditDeployment(db, entry, {
      action: 'teamDeployment.request',
      actorUserId: requestedBy
    })

    return toDeploymentView({ teamId, environment }, entry)
  } finally {
    await lock.free()
  }
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

function entryFilter(doc, entry) {
  return {
    _id: doc._id,
    deployments: { $elemMatch: { id: entry.id, status: entry.status } }
  }
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

/**
 * Persists a status result with compare-and-set on the entry's id and the
 * status read, so a slower concurrent poll never overwrites a newer status
 * with its stale one, and audits a transition once. Reaching `active` adds
 * the model to the team's `gateway.allowedDeployments`.
 */
async function persistStatus(db, doc, entry, result) {
  const update = {}

  if (result.status !== entry.status) {
    update.status = result.status

    if (result.status === 'active') {
      update.activatedAt = new Date().toISOString()
    }

    if (TERMINAL_FAILURE_STATUSES.includes(result.status)) {
      update.failureReason = result.failureReason ?? 'unknown'
    }
  }

  const gitopsUpdate = entry.gitops ? gitopsChangesOf(result, entry.gitops) : {}

  if (
    Object.keys(update).length === 0 &&
    Object.keys(gitopsUpdate).length === 0
  ) {
    return { entry, transitioned: false }
  }

  const updateOps = {
    $set: {
      ...Object.fromEntries(
        Object.entries(update).map(([key, value]) => [
          `deployments.$.${key}`,
          value
        ])
      ),
      ...Object.fromEntries(
        Object.entries(gitopsUpdate).map(([key, value]) => [
          `deployments.$.gitops.${key}`,
          value
        ])
      )
    }
  }

  if (update.status === 'active') {
    updateOps.$addToSet = { 'gateway.allowedDeployments': entry.modelSlug }
  }

  const { matchedCount } = await db
    .collection('teamDeployments')
    .updateOne(entryFilter(doc, entry), updateOps)

  if (matchedCount === 0) {
    const fresh = await db
      .collection('teamDeployments')
      .findOne({ _id: doc._id })

    return { entry: findEntry(fresh, entry.id) ?? entry, transitioned: false }
  }

  if (update.status) {
    await auditDeployment(db, entry, {
      action: 'teamDeployment.transition',
      outcome: TERMINAL_FAILURE_STATUSES.includes(update.status)
        ? 'failure'
        : 'success',
      code: update.status,
      reason: `${entry.status} -> ${update.status}`
    })
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
  const waiting = { ...result, status: 'deploying', failure: undefined }

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
  if (
    !(Date.parse(result.failure.observedAt) > Date.parse(retry.dispatchedAt))
  ) {
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
    entry.status === 'checks-failed' &&
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
async function refreshEntryStatus(
  db,
  doc,
  entry,
  { registry = tenantOrchestratorRegistry, logger } = {}
) {
  if (
    entry.status === 'active' ||
    TERMINAL_FAILURE_STATUSES.includes(entry.status)
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

  if (result.status === 'deploy-failed' && result.failure && entry.gitops) {
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

/**
 * Finds one deployment entry by id for the "being set up" poll, refreshing
 * its status first. Returns null (not a 403) for a non-member so existence
 * isn't disclosed.
 * @param {import('mongodb').Db} db
 * @param {{id: string, teamId: string, userId: string}} params
 * @param {{registry?: object, logger?: import('pino').Logger}} [deps]
 */
export async function getDeployment(db, { id, teamId, userId }, deps = {}) {
  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId, status: 'active' })

  if (!membership) {
    return null
  }

  const doc = await db
    .collection('teamDeployments')
    .findOne({ teamId, 'deployments.id': id })

  const entry = findEntry(doc, id)

  if (!doc || !entry) {
    return null
  }

  const refreshed = await refreshEntryStatus(db, doc, entry, deps)

  return toDeploymentView(doc, refreshed)
}

/**
 * Lists every deployment entry for a team (any status, any environment),
 * refreshing each one's status first - powers the "check progress" links on
 * `/manage` so a request stays reachable even after the requester navigates
 * away or signs back in later. Throws 404 for a non-member so existence
 * isn't disclosed.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, userId: string}} params
 * @param {{registry?: object, logger?: import('pino').Logger}} [deps]
 */
export async function listDeploymentsForTeam(
  db,
  { teamId, userId },
  deps = {}
) {
  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId, status: 'active' })

  if (!membership) {
    throw Boom.notFound()
  }

  const docs = await db.collection('teamDeployments').find({ teamId }).toArray()

  const views = []

  for (const doc of docs) {
    for (const entry of doc.deployments ?? []) {
      // Sequential by design: each refresh may write back to the same
      // document, and entries share one document per team+environment.
      const refreshed = await refreshEntryStatus(db, doc, entry, deps)
      views.push(toDeploymentView(doc, refreshed))
    }
  }

  return views
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
  const { registry = tenantOrchestratorRegistry, logger } = deps
  const docs = await db
    .collection('teamDeployments')
    .find({
      deployments: {
        $elemMatch: {
          orchestrator: GITHUB_ORCHESTRATOR,
          $or: [
            { status: { $in: NON_TERMINAL_STATUSES } },
            {
              status: 'checks-failed',
              'gitops.pullRequestNumber': { $ne: null },
              'gitops.abandon': null
            }
          ]
        }
      }
    })
    .toArray()

  let polled = 0
  let transitioned = 0
  let abandoned = 0

  for (const doc of docs) {
    for (const entry of doc.deployments) {
      if (entry.orchestrator !== GITHUB_ORCHESTRATOR) {
        continue
      }

      if (needsAbandon(entry)) {
        await abandonOperation(db, doc, entry, {
          orchestrator: registry.forEntry(entry),
          logger
        })
        abandoned += 1
      } else if (NON_TERMINAL_STATUSES.includes(entry.status)) {
        const refreshed = await refreshEntryStatus(db, doc, entry, deps)

        polled += 1
        transitioned += refreshed.status === entry.status ? 0 : 1
      }
    }
  }

  return { polled, transitioned, abandoned }
}

/**
 * Platform Admin retry or reconcile: dispatches a fresh tenants apply on
 * `main` for the deployment's environment (never a re-run), recorded as
 * `retry` or `reconcile`. A `deploy-failed` deployment goes back to
 * `deploying` and is polled again; the dispatched apply counts as its one
 * D14 retry. Retry is only for a failed deployment; reconcile is for any.
 * @param {import('mongodb').Db} db
 * @param {{id: string, actorUserId: string, kind: 'retry'|'reconcile'}} params
 * @param {{registry?: object}} [deps]
 */
export async function redispatchApply(
  db,
  { id, actorUserId, kind },
  { registry = tenantOrchestratorRegistry } = {}
) {
  await requirePlatformAdmin(db, actorUserId)

  const doc = await db
    .collection('teamDeployments')
    .findOne({ 'deployments.id': id })
  const entry = findEntry(doc, id)

  if (!entry) {
    throw Boom.notFound()
  }

  if (kind === 'retry' && entry.status !== 'deploy-failed') {
    throw boomWithCode(
      Boom.conflict,
      'Only a failed deployment can be retried',
      'deployment-not-retryable'
    )
  }

  let run

  try {
    run = await registry.forEntry(entry).requestApply({
      environment: doc.environment,
      reason: `${kind} ${entry.operationId}`
    })
  } catch {
    await auditDeployment(db, entry, {
      action: `teamDeployment.${kind}`,
      actorUserId,
      outcome: 'failure',
      code: 'upstream-unavailable'
    })

    throw boomWithCode(
      Boom.badGateway,
      'Failed to dispatch the apply',
      'upstream-unavailable'
    )
  }

  const resumes = entry.status === 'deploy-failed'
  const applyRetry = {
    dispatchedAt: new Date().toISOString(),
    reason: kind,
    ...run
  }
  const update = {
    ...(resumes ? { status: 'deploying', failureReason: null } : {}),
    ...(entry.gitops ? { 'gitops.applyRetry': applyRetry } : {})
  }

  if (Object.keys(update).length > 0) {
    await db.collection('teamDeployments').updateOne(entryFilter(doc, entry), {
      $set: Object.fromEntries(
        Object.entries(update).map(([key, value]) => [
          `deployments.$.${key}`,
          value
        ])
      )
    })
  }

  await auditDeployment(db, entry, {
    action: `teamDeployment.${kind}`,
    actorUserId,
    reason: resumes ? 'deploy-failed -> deploying' : null
  })

  return toDeploymentView(doc, {
    ...entry,
    ...(resumes ? { status: 'deploying', failureReason: null } : {}),
    gitops: entry.gitops ? { ...entry.gitops, applyRetry } : null
  })
}

/**
 * Finds the active deployment entry for a team+model+environment, used by
 * `credential-service.js` to gate team-tier credential issuance. Does not
 * refresh status itself - the requester's poll of `getDeployment` above is
 * what keeps the persisted record up to date.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, modelSlug: string, environment: string}} params
 */
export async function findActiveDeployment(
  db,
  { teamId, modelSlug, environment }
) {
  const doc = await db.collection('teamDeployments').findOne({
    teamId,
    environment,
    deployments: { $elemMatch: { modelSlug, status: 'active' } }
  })

  return (
    doc?.deployments?.find(
      (deployment) =>
        deployment.modelSlug === modelSlug && deployment.status === 'active'
    ) ?? null
  )
}

/**
 * Fixes a team's gateway credential type for an environment on first use, or
 * rejects a later request that asks for a different one
 * (`credential-type-fixed`) - design C's "one credential type per team per
 * environment", chosen once and changed only by a team-file edit.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string, credentialType: 'oauth'|'subscription-key'}} params
 * @returns {Promise<{credentialType: 'oauth'|'subscription-key', wasNewlyReserved: boolean}>}
 */
export async function reserveCredentialType(
  db,
  { teamId, environment, credentialType }
) {
  const now = new Date().toISOString()

  const reserved = await db.collection('teamDeployments').findOneAndUpdate(
    { teamId, environment, 'gateway.credentialType': null },
    {
      $set: {
        'gateway.credentialType': credentialType,
        'oauthClient.enabled': credentialType === 'oauth',
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  )

  if (reserved) {
    return { credentialType, wasNewlyReserved: true }
  }

  const doc = await db
    .collection('teamDeployments')
    .findOne({ teamId, environment })
  const existingType = doc?.gateway?.credentialType

  if (existingType && existingType !== credentialType) {
    throw boomWithCode(
      Boom.conflict,
      'This team already uses a different credential type in this environment',
      'credential-type-fixed'
    )
  }

  return {
    credentialType: existingType ?? credentialType,
    wasNewlyReserved: false
  }
}

/**
 * Undoes a reservation made by `reserveCredentialType` when the credential
 * issue that relied on it subsequently fails, so a retry (or another team
 * member) isn't permanently locked into a credential type that was never
 * actually issued. Only resets the gateway if it's still set to the type
 * being released, so it can't clobber a genuine concurrent reservation.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string, credentialType: 'oauth'|'subscription-key'}} params
 */
export async function releaseCredentialTypeReservation(
  db,
  { teamId, environment, credentialType }
) {
  await db.collection('teamDeployments').updateOne(
    { teamId, environment, 'gateway.credentialType': credentialType },
    {
      $set: {
        'gateway.credentialType': null,
        'oauthClient.enabled': false,
        updatedAt: new Date().toISOString()
      }
    }
  )
}
