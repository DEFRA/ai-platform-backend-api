import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { findModelBySlug } from '#/services/models-service.js'
import {
  tenantOrchestratorRegistry,
  GITHUB_ORCHESTRATOR
} from '#/adapters/tenant-orchestrator-registry.js'
import {
  requirePlatformAdmin,
  requireUserPrincipal
} from '#/services/user-service.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import {
  DEPLOY_FAILED,
  TERMINAL_FAILURE_STATUSES,
  auditDeployment,
  entryFilter,
  findEntry
} from '#/services/team-deployment-entries.js'
import { refreshEntryStatus } from '#/services/team-deployment-gitops.js'
import { settleGitopsStep } from '#/services/team-deployment-gitops-steps.js'

const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'
const DESIRED_STATE_TOO_LARGE = 'desired-state-too-large'

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

/**
 * Builds the four fixed-label progress steps shown on the team-request wait
 * page, marking each `done`/`current`/`pending` relative to the deployment's
 * current raw status. Returns `null` for a terminal failure status - the
 * frontend shows its own failure messaging instead of a step list there.
 * @param {string} status
 */
function buildProgressSteps(status) {
  if (TERMINAL_FAILURE_STATUSES.has(status)) {
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

/**
 * The WS6 seam: the GitHub orchestrator submits a whole desired-state
 * document, which only the Teams developer's builder (with the team's
 * immutable `slug`) can produce. Until it is supplied, GitHub-mode requests
 * fail with `501 desired-state-unavailable`; the mock needs no document.
 * The document's `updatedBy` is always the requester's principal, which the
 * submit workflow requires to equal `requested_by`.
 * @param {(db: import('mongodb').Db, params: {teamId: string, environment: string, modelSlug: string, operationId: string, requestedBy: string}) => Promise<{document: object, expectedRevision: number}|null>} [buildDesiredState]
 * @param {import('mongodb').Db} db
 * @param {object} params
 * @param {string} principal - `entra:{oid}` of the requester
 */
async function buildSubmission(buildDesiredState, db, params, principal) {
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
    document: { ...desired.document, updatedBy: principal },
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
 * (`gitops`: path, branch, runs, pull request, SHAs, resources). The change
 * is submitted as the requester's `entra:{oid}`; a user with no Entra object
 * ID is refused with `403 entra-identity-required`.
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

  // The GitOps change is attributed to the person's Entra object ID; the
  // portal's own user ID stays the key for authorisation.
  const principal = await requireUserPrincipal(db, requestedBy)

  // Several models can now be requested for the same team+environment
  // document, so a plain unique index can no longer detect an
  // idempotency-key replay or a duplicate model by itself - every mutation
  // of the document is serialised behind this lock instead.
  const lock = await acquireLockWithRetry(
    locker,
    `team-deployment:${teamId}:${environment}`
  )

  try {
    return await addDeployment(
      db,
      {
        teamId,
        modelSlug,
        environment,
        requestedBy,
        principal,
        idempotencyKey,
        traceParent
      },
      { registry, buildDesiredState }
    )
  } finally {
    await lock.free()
  }
}

// The locked part of `requestDeployment`: replays an idempotency key,
// refuses a second deployment of the same model, otherwise records a new
// entry and submits it.
async function addDeployment(db, params, deps) {
  const { teamId, environment, modelSlug, idempotencyKey } = params
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

  const { entry, submission } = await newEntry(db, params, deps)

  await insertEntry(db, params, entry)

  const submitted = await submitEntry(
    db,
    params,
    entry,
    submission,
    deps.registry
  )

  await recordSubmitRun(db, params, entry, submitted)
  await auditDeployment(db, entry, {
    action: 'teamDeployment.request',
    actorUserId: params.requestedBy
  })

  return toDeploymentView({ teamId, environment }, entry)
}

// A new `requested` entry and what to submit for it: for GitHub, the whole
// desired-state document and its GitOps trail; the mock needs neither.
async function newEntry(
  db,
  { teamId, environment, modelSlug, requestedBy, principal, idempotencyKey },
  { registry, buildDesiredState }
) {
  const operationId = new ObjectId().toString()
  const isGithub = registry.key === GITHUB_ORCHESTRATOR
  const submission = isGithub
    ? await buildSubmission(
        buildDesiredState,
        db,
        { teamId, environment, modelSlug, operationId, requestedBy },
        principal
      )
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

  return { entry, submission }
}

// Adds the entry to the team's document for the environment, creating the
// document on the team's first request there.
async function insertEntry(db, { teamId, environment }, entry) {
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
        createdAt: entry.createdAt
      },
      $set: { updatedAt: entry.createdAt }
    },
    { upsert: true }
  )
}

// Submits the entry to the orchestrator. If that fails, the entry is pulled
// so a retry can start cleanly - it never reached the orchestrator, so
// nothing needs unwinding on that side either.
async function submitEntry(db, params, entry, submission, registry) {
  const { teamId, environment, requestedBy, principal, traceParent } = params

  try {
    return await registry.orchestrator.requestDeployment({
      environment,
      path: submission.path,
      document: submission.document,
      operationId: entry.operationId,
      requestedBy: principal,
      expectedRevision: submission.expectedRevision,
      action: 'write',
      traceParent: W3C_TRACEPARENT.test(traceParent ?? '')
        ? traceParent
        : undefined
    })
  } catch (error) {
    const code =
      error.code === DESIRED_STATE_TOO_LARGE
        ? DESIRED_STATE_TOO_LARGE
        : UPSTREAM_UNAVAILABLE

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

    throw code === DESIRED_STATE_TOO_LARGE
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
}

// Stores the submit run on a GitHub entry's GitOps trail.
async function recordSubmitRun(db, { teamId, environment }, entry, submitted) {
  if (!entry.gitops) {
    return
  }

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

function entryFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      `deployments.$.${key}`,
      value
    ])
  )
}

// What a retry or reconcile claims before it dispatches: a failed
// deployment resuming, and the apply about to go out as its one D14 retry.
function redispatchClaim(entry, kind) {
  const resumes = entry.status === DEPLOY_FAILED

  return {
    resumes,
    changes: resumes ? { status: 'deploying', failureReason: null } : {},
    applyRetry: entry.gitops
      ? { claimedAt: new Date().toISOString(), reason: kind }
      : null
  }
}

// Claims before dispatching. Resuming is a compare-and-set from
// `deploy-failed`, so of two concurrent requests only one dispatches; a
// claim that resumes nothing cannot conflict. False if another request won.
async function claimRedispatch(db, doc, entry, claim) {
  const update = {
    ...claim.changes,
    ...(claim.applyRetry ? { 'gitops.applyRetry': claim.applyRetry } : {})
  }

  if (Object.keys(update).length === 0) {
    return true
  }

  const { matchedCount } = await db
    .collection('teamDeployments')
    .updateOne(
      claim.resumes
        ? entryFilter(doc, entry)
        : { _id: doc._id, 'deployments.id': entry.id },
      { $set: entryFields(update) }
    )

  return matchedCount === 1
}

// Puts the entry back as it was after GitHub refused the dispatch, unless
// something has moved it on since.
async function releaseRedispatch(db, doc, entry, claim) {
  const restore = {
    ...(claim.resumes
      ? { status: entry.status, failureReason: entry.failureReason }
      : {}),
    ...(claim.applyRetry
      ? { 'gitops.applyRetry': entry.gitops.applyRetry ?? null }
      : {})
  }
  const held = {
    id: entry.id,
    ...(claim.resumes ? { status: claim.changes.status } : {}),
    ...(claim.applyRetry
      ? { 'gitops.applyRetry.claimedAt': claim.applyRetry.claimedAt }
      : {})
  }

  if (Object.keys(restore).length > 0) {
    await db
      .collection('teamDeployments')
      .updateOne(
        { _id: doc._id, deployments: { $elemMatch: held } },
        { $set: entryFields(restore) }
      )
  }
}

// The deployment as the request that won a concurrent retry left it.
async function currentView(db, doc, entry) {
  const fresh = await db.collection('teamDeployments').findOne({ _id: doc._id })

  return toDeploymentView(doc, findEntry(fresh, entry.id) ?? entry)
}

/**
 * Platform Admin retry or reconcile: dispatches a fresh tenants apply on
 * `main` for the deployment's environment (never a re-run), recorded as
 * `retry` or `reconcile`. A `deploy-failed` deployment goes back to
 * `deploying` and is polled again; the dispatched apply counts as its one
 * D14 retry. Retry is only for a failed deployment; reconcile is for any.
 * The request claims the deployment atomically before dispatching, so of
 * two concurrent requests to resume it one dispatches; the other dispatches
 * and audits nothing and returns the deployment as the first left it.
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

  if (kind === 'retry' && entry.status !== DEPLOY_FAILED) {
    throw boomWithCode(
      Boom.conflict,
      'Only a failed deployment can be retried',
      'deployment-not-retryable'
    )
  }

  const claim = redispatchClaim(entry, kind)

  if (!(await claimRedispatch(db, doc, entry, claim))) {
    return currentView(db, doc, entry)
  }

  let run

  try {
    run = await registry.forEntry(entry).requestApply({
      environment: doc.environment,
      reason: `${kind} ${entry.operationId}`
    })
  } catch {
    await releaseRedispatch(db, doc, entry, claim)
    await auditDeployment(db, entry, {
      action: `teamDeployment.${kind}`,
      actorUserId,
      outcome: 'failure',
      code: UPSTREAM_UNAVAILABLE
    })

    throw boomWithCode(
      Boom.badGateway,
      'Failed to dispatch the apply',
      UPSTREAM_UNAVAILABLE
    )
  }

  const applyRetry = claim.applyRetry && {
    ...claim.applyRetry,
    dispatchedAt: new Date().toISOString(),
    ...run
  }

  if (applyRetry) {
    await settleGitopsStep(
      db,
      doc,
      entry,
      'applyRetry',
      claim.applyRetry,
      applyRetry
    )
  }

  await auditDeployment(db, entry, {
    action: `teamDeployment.${kind}`,
    actorUserId,
    reason: claim.resumes ? 'deploy-failed -> deploying' : null
  })

  return toDeploymentView(doc, {
    ...entry,
    ...claim.changes,
    gitops: entry.gitops ? { ...entry.gitops, applyRetry } : null
  })
}
