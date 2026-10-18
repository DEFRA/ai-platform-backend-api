import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { config } from '#/config.js'
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
  QUEUED,
  REMOVED,
  auditDeployment,
  entryFields,
  entryFilter,
  findEntry
} from '#/services/team-deployment-entries.js'
import { refreshEntryStatus } from '#/services/team-deployment-gitops.js'
import { mustQueue } from '#/services/team-deployment-queue.js'
import {
  githubTrailOf,
  prepareSubmission,
  submissionRequest
} from '#/services/team-deployment-submission.js'
import { settleGitopsStep } from '#/services/team-deployment-gitops-steps.js'
import { teamDesiredStateBuilder } from '#/services/team-desired-state.js'
import { toDeploymentView } from '#/services/team-deployment-view.js'

const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'
const REQUEST_ACTION = 'teamDeployment.request'
const DESIRED_STATE_TOO_LARGE = 'desired-state-too-large'

/**
 * The most models one request can ask for: a team file holds 20 deployments
 * (`team.schema.json`).
 */
export const MAX_MODELS_PER_REQUEST = 20

/**
 * The environments this portal instance may deploy a team's models to
 * (`teamDeployment.environments`, D1): a schema-valid environment outside
 * the list is refused as `environment-not-available`, so adding one is a
 * configuration change, never a code change.
 * @returns {string[]}
 */
export function teamEnvironments() {
  return config.get('teamDeployment.environments')
}

function requireTeamEnvironment(environment) {
  if (!teamEnvironments().includes(environment)) {
    throw boomWithCode(
      Boom.forbidden,
      'This environment is not available yet',
      'environment-not-available'
    )
  }
}

/**
 * Requests provisioning of a team's dedicated model deployments (B09), one
 * or several models at once. One document per team per environment holds
 * every model the team has requested there, mirroring design C's
 * `environments/{env}/{team}.json` shape (`gateway.allowedDeployments` etc.)
 * - requesting more models for a team that already has a document for this
 * environment extends it, rather than creating a sibling document. Only the
 * environments in `teamDeployment.environments` are allowed from this portal
 * instance, even though the schema accepts every design C environment - a new
 * environment is a configuration change, not a code change. Each model gets
 * its own entry and operation, in the order asked, so one that fails never
 * holds back the others; submit allows one open operation per team file, so
 * every entry after the first waits its turn as `queued`. The request is
 * all or nothing up front - a model that is not eligible, or that the team
 * already has, refuses the whole request before anything is created - and
 * idempotent by key: replaying a key returns its entries, and finishes any a
 * crashed attempt did not get to. Each entry records the orchestrator that
 * submitted it and, for GitHub, its GitOps trail (`gitops`: path, branch,
 * runs, pull request, SHAs, resources). The change is submitted as the
 * requester's `entra:{oid}`; a user with no Entra object ID is refused with
 * `403 entra-identity-required`.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, modelSlugs: string[], environment: string, requestedBy: string, idempotencyKey: string, traceParent?: string}} params
 * @param {{registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry, buildDesiredState?: Function}} [deps]
 * @returns {Promise<object[]>} One view per model, in the order asked.
 */
export async function requestDeployments(
  db,
  locker,
  { teamId, modelSlugs, environment, requestedBy, idempotencyKey, traceParent },
  {
    registry = tenantOrchestratorRegistry,
    buildDesiredState = teamDesiredStateBuilder
  } = {}
) {
  requireTeamEnvironment(environment)

  const membership = await db
    .collection('teamMembers')
    .findOne({ teamId, userId: requestedBy, status: 'active' })

  if (!membership) {
    throw Boom.notFound()
  }

  const slugs = [...new Set(modelSlugs)]

  await requireEligibleModels(db, slugs, environment)

  // The GitOps change is attributed to the person's Entra object ID; the
  // portal's own user ID stays the key for authorisation.
  const principal = await requireUserPrincipal(db, requestedBy)

  // Several models can be requested for the same team+environment
  // document, so a plain unique index can no longer detect an
  // idempotency-key replay or a duplicate model by itself - every mutation
  // of the document is serialised behind this lock instead.
  const lock = await acquireLockWithRetry(
    locker,
    `team-deployment:${teamId}:${environment}`
  )

  try {
    return await addDeployments(
      db,
      {
        teamId,
        modelSlugs: slugs,
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

// Refuses the whole request, naming every offender, if any model cannot be
// deployed to the team tier in this environment.
async function requireEligibleModels(db, slugs, environment) {
  const models = await Promise.all(
    slugs.map((slug) => findModelBySlug(db, slug))
  )
  const refused = slugs.filter((_slug, index) => {
    const model = models[index]

    return (
      !model?.eligible ||
      !model.tiers?.includes('team') ||
      !model.environments?.includes(environment)
    )
  })

  if (refused.length > 0) {
    throw boomWithCode(
      Boom.forbidden,
      'Model is not eligible for this environment',
      'model-not-eligible',
      { modelSlugs: refused }
    )
  }
}

// The locked part of `requestDeployments`: refuses the request if the team
// already has any of its models (one it removed does not count), then
// reuses the entry an earlier attempt of this key made for a model, or
// records and submits a new one.
async function addDeployments(db, params, deps) {
  const { teamId, environment, modelSlugs, idempotencyKey } = params
  const doc = await db
    .collection('teamDeployments')
    .findOne({ teamId, environment })
  const held = doc?.deployments ?? []
  const earlier = new Map(
    held
      .filter((entry) => entry.idempotencyKey === idempotencyKey)
      .map((entry) => [entry.modelSlug, entry])
  )
  const existing = held.filter(
    (entry) =>
      modelSlugs.includes(entry.modelSlug) &&
      entry.status !== REMOVED &&
      earlier.get(entry.modelSlug) !== entry
  )

  if (existing.length > 0) {
    throw boomWithCode(
      Boom.conflict,
      'A deployment already exists for this team and model',
      'deployment-exists',
      {
        existingId: existing[0].id,
        existing: existing.map(({ id, modelSlug }) => ({ id, modelSlug }))
      }
    )
  }

  const views = []

  for (const modelSlug of modelSlugs) {
    const entry = earlier.get(modelSlug)

    views.push(
      entry
        ? toDeploymentView(doc, entry)
        : await addDeployment(db, { ...params, modelSlug }, deps)
    )
  }

  return views
}

// Records and submits one model's entry, or queues it behind the operation
// holding the team file (or the entries already waiting).
async function addDeployment(db, params, deps) {
  const { teamId, environment } = params

  // Submit allows one open operation per team file, so a request made while
  // another holds it (or earlier ones wait) waits its turn.
  if (await mustQueue(db, params)) {
    return queueDeployment(db, params, deps)
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
    action: REQUEST_ACTION,
    actorUserId: params.requestedBy
  })

  return toDeploymentView({ teamId, environment }, entry)
}

// The fields every new entry starts with, `requested` or `queued`. The
// requester's principal is kept so a queued request is dispatched as them.
function freshEntry(
  { modelSlug, requestedBy, principal, idempotencyKey },
  { registry },
  status
) {
  return {
    id: new ObjectId().toString(),
    modelSlug,
    status,
    operationId: new ObjectId().toString(),
    requestedBy,
    requestedByPrincipal: principal,
    idempotencyKey,
    createdAt: new Date().toISOString(),
    activatedAt: null,
    failureReason: null,
    orchestrator: registry.key,
    gitops: null
  }
}

// A request queued behind the operation holding its team file, recorded
// and audited but neither built nor dispatched until that one ends.
async function queueDeployment(db, params, deps) {
  const entry = freshEntry(params, deps, QUEUED)

  await insertEntry(db, params, entry)
  await auditDeployment(db, entry, {
    action: REQUEST_ACTION,
    actorUserId: params.requestedBy,
    code: QUEUED
  })

  return toDeploymentView(params, entry)
}

// A new `requested` entry and what to submit for it: for GitHub, the whole
// desired-state document and its GitOps trail; the mock needs neither.
async function newEntry(db, params, deps) {
  const { teamId, environment, modelSlug, requestedBy, principal } = params
  const isGithub = deps.registry.key === GITHUB_ORCHESTRATOR
  const entry = freshEntry(params, deps, 'requested')
  const submission = await prepareSubmission(
    db,
    { isGithub, buildDesiredState: deps.buildDesiredState },
    {
      teamId,
      environment,
      modelSlug,
      operationId: entry.operationId,
      requestedBy
    },
    principal
  )

  if (isGithub) {
    entry.gitops = githubTrailOf(submission, entry.operationId)
  }

  return { entry, submission }
}

// Adds the entry to the team's document for the environment, creating the
// document on the team's first request there. The team tier is OAuth only,
// so a team's gateway always takes OAuth credentials.
async function insertEntry(db, { teamId, environment }, entry) {
  await db.collection('teamDeployments').updateOne(
    { teamId, environment },
    {
      $push: { deployments: entry },
      $setOnInsert: {
        teamId,
        environment,
        gateway: {
          credentialType: 'oauth',
          allowedDeployments: [],
          limits: {}
        },
        oauthClient: { enabled: true, appRoles: [] },
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
    return await registry.orchestrator.requestDeployment(
      submissionRequest(
        { environment, operationId: entry.operationId, principal, traceParent },
        submission
      )
    )
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
      action: REQUEST_ACTION,
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

// Dispatches the apply for a claimed redispatch; a refusal releases the
// claim, audits the failure and reports upstream trouble.
async function dispatchRedispatch(
  db,
  doc,
  entry,
  claim,
  { registry, kind, actorUserId }
) {
  try {
    return await registry.forEntry(entry).requestApply({
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

  const run = await dispatchRedispatch(db, doc, entry, claim, {
    registry,
    kind,
    actorUserId
  })

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
