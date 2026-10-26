import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { config } from '#/config.js'
import { findModelBySlug } from '#/services/models-service.js'
import { isTeamEligible } from '#/services/catalogue-service.js'
import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import {
  requirePlatformAdmin,
  requireUserPrincipal
} from '#/services/user-service.js'
import { acquireLockWithRetry } from '#/common/helpers/mongo-lock.js'
import { findOperation } from '#/operations/operation-repository.js'
import { projectOperation } from '#/operations/operation-projection.js'
import {
  QUEUED,
  REMOVED,
  auditDeployment,
  findEntry
} from '#/services/team-deployment-entries.js'
import { refusalOf, traceOf } from '#/services/team-deployment-submission.js'
import { resolveTeamTarget } from '#/services/team-desired-state.js'
import { resolveTeamId } from '#/services/team-service.js'
import { toDeploymentView } from '#/services/team-deployment-view.js'

const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'
const REQUEST_ACTION = 'teamDeployment.request'

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

// The deployment as the API returns it, its step labels naming the model by
// its display name (the catalogue read is cached).
async function viewOf(db, doc, entry) {
  const model = await findModelBySlug(db, entry.modelSlug)

  return toDeploymentView(doc, entry, undefined, model?.displayName)
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
 * environment is a configuration change, not a code change. The request is
 * one operation for the team file, whatever the number of models: it commits
 * the whole file once, and every entry follows that operation's states
 * together. While another operation holds the file, or the environment is
 * paused, the request waits as `queued` and later requests merge into it. The
 * request is all or nothing up front - a model that is not eligible, or that
 * the team already has, refuses the whole request before anything is
 * created - and idempotent by key: replaying a key (a merged request's too)
 * returns its entries. A request that cannot be accepted queues nothing. The
 * change is submitted as the requester's `entra:{oid}`; a user with no Entra
 * object ID is refused with `403 entra-identity-required`.
 * @param {import('mongodb').Db} db
 * @param {import('mongo-locks').LockManager} locker
 * @param {{teamId: string, modelSlugs: string[], environment: string, requestedBy: string, idempotencyKey: string, purpose?: string, traceParent?: string, cdpRequestId?: string}} params - `teamId` is the team's id or slug; `purpose` only matters to the mock orchestrator
 * @param {{operations: ReturnType<typeof import('#/operations/operations-service.js').createOperationsService>, registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} deps
 * @returns {Promise<object[]>} One view per model, in the order asked.
 */
export async function requestDeployments(
  db,
  locker,
  {
    teamId: teamRef,
    modelSlugs,
    environment,
    requestedBy,
    idempotencyKey,
    purpose,
    traceParent,
    cdpRequestId
  },
  { operations, registry = tenantOrchestratorRegistry }
) {
  requireTeamEnvironment(environment)

  const teamId = await resolveTeamId(db, teamRef)
  const membership = teamId
    ? await db
        .collection('teamMembers')
        .findOne({ teamId, userId: requestedBy, status: 'active' })
    : null

  if (!membership) {
    throw Boom.notFound()
  }

  const slugs = [...new Set(modelSlugs)]

  await requireEligibleModels(db, slugs, environment)

  // The GitOps change is attributed to the person's Entra object ID; the
  // portal's own user ID stays the key for authorisation.
  const principal = await requireUserPrincipal(db, requestedBy)

  // Several models can be requested for the same team+environment
  // document, so a plain unique index can no longer detect a duplicate model
  // by itself - every mutation of the document is serialised behind this
  // lock instead.
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
        mockOutcome: registry.mockOutcomeOf(purpose),
        ...traceOf({ traceParent, cdpRequestId })
      },
      operations
    )
  } finally {
    await lock.free()
  }
}

// Refuses the whole request, naming every offender, if any model cannot be
// deployed for a team in this environment (the catalogue service's one rule),
// before anything is written.
async function requireEligibleModels(db, slugs, environment) {
  const models = await Promise.all(
    slugs.map((slug) => findModelBySlug(db, slug))
  )
  const refused = slugs.filter(
    (_slug, index) => !isTeamEligible(models[index], environment)
  )

  if (refused.length > 0) {
    throw boomWithCode(
      Boom.badRequest,
      'Model is not eligible for this environment',
      'model-not-eligible',
      { modelSlugs: refused }
    )
  }
}

// The locked part of `requestDeployments`: refuses the request if the team
// already has any of its models (one it removed does not count), then
// reuses the entries an earlier attempt of this key made, records the others
// and asks for one operation over all of them.
async function addDeployments(db, params, operations) {
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

  // Resolved first: a team that cannot have a file built has nothing recorded.
  const target = await resolveTeamTarget(db, { teamId, environment })
  const entries = modelSlugs.map(
    (modelSlug) =>
      earlier.get(modelSlug) ?? freshEntry({ ...params, modelSlug })
  )
  const fresh = entries.filter((entry) => !earlier.has(entry.modelSlug))

  if (fresh.length > 0) {
    await insertEntries(db, params, fresh)
  }

  const operation = await submitOperation(db, params, {
    operations,
    target,
    entries,
    fresh
  })

  await projectOperation(db, operation)

  for (const entry of fresh) {
    await auditDeployment(db, entry, {
      action: REQUEST_ACTION,
      actorUserId: params.requestedBy,
      ...(operation.state === QUEUED ? { code: QUEUED } : {})
    })
  }

  const current = await db
    .collection('teamDeployments')
    .findOne({ teamId, environment })

  return Promise.all(
    entries.map((entry) => viewOf(db, current, findEntry(current, entry.id)))
  )
}

// The fields every new entry starts with. Its status and operation are
// written by the operation's projection.
function freshEntry({ modelSlug, requestedBy, idempotencyKey }) {
  return {
    id: new ObjectId().toString(),
    modelSlug,
    status: QUEUED,
    statusTimes: {},
    operationId: null,
    requestedBy,
    idempotencyKey,
    createdAt: new Date().toISOString(),
    activatedAt: null,
    failureReason: null
  }
}

// Adds the entries to the team's document for the environment, creating the
// document on the team's first request there. The team tier is OAuth only,
// so a team's gateway always takes OAuth credentials.
async function insertEntries(db, { teamId, environment }, entries) {
  await db.collection('teamDeployments').updateOne(
    { teamId, environment },
    {
      $push: { deployments: { $each: entries } },
      $setOnInsert: {
        teamId,
        environment,
        gateway: {
          credentialType: 'oauth',
          allowedDeployments: [],
          limits: {}
        },
        oauthClient: { enabled: true, appRoles: [], registration: null },
        createdAt: entries[0].createdAt
      },
      $set: { updatedAt: entries[0].createdAt }
    },
    { upsert: true }
  )
}

// Asks for the operation over the entries. If it is refused (a policy
// refusal, or the document cannot be built), the entries recorded for it are
// pulled so a retry can start cleanly: nothing was queued, so nothing needs
// unwinding on the other side.
async function submitOperation(
  db,
  params,
  { operations, target, entries, fresh }
) {
  const { teamId, environment, requestedBy, principal } = params

  try {
    const { operation, replay } = await operations.request({
      teamId,
      environment,
      target,
      items: entries.map(({ id, modelSlug }) => ({
        entryId: id,
        modelSlug,
        change: 'add'
      })),
      requestedBy: principal,
      requestedByUserId: requestedBy,
      idempotencyKey: params.idempotencyKey,
      traceparent: params.traceparent,
      cdpRequestId: params.cdpRequestId,
      mockOutcome: params.mockOutcome
    })

    // The key made an operation that does not cover these models: it was
    // used for another request, and these entries belong to none.
    if (replay && fresh.length > 0) {
      throw boomWithCode(
        Boom.conflict,
        'This idempotency key was used for a different request',
        'idempotency-key-reused'
      )
    }

    return operation
  } catch (error) {
    const refusal = refusalOf(error, 'Failed to request the team deployment')

    if (fresh.length > 0) {
      await db.collection('teamDeployments').updateOne(
        { teamId, environment },
        {
          $pull: { deployments: { id: { $in: fresh.map(({ id }) => id) } } }
        }
      )
    }

    await Promise.all(
      fresh.map((entry) =>
        auditDeployment(db, entry, {
          action: REQUEST_ACTION,
          actorUserId: requestedBy,
          outcome: 'failure',
          code: refusal.data?.code ?? UPSTREAM_UNAVAILABLE
        })
      )
    )

    throw refusal
  }
}

async function requireMember(db, teamRef, userId) {
  const teamId = await resolveTeamId(db, teamRef)
  const membership = teamId
    ? await db
        .collection('teamMembers')
        .findOne({ teamId, userId, status: 'active' })
    : null

  return membership ? teamId : null
}

/**
 * Finds one deployment entry by id for the "being set up" poll. Returns null
 * (not a 403) for a non-member so existence isn't disclosed.
 * @param {import('mongodb').Db} db
 * @param {{id: string, teamId: string, userId: string}} params - `teamId` is the team's id or slug
 */
export async function getDeployment(db, { id, teamId: teamRef, userId }) {
  const teamId = await requireMember(db, teamRef, userId)

  if (!teamId) {
    return null
  }

  const doc = await db
    .collection('teamDeployments')
    .findOne({ teamId, 'deployments.id': id })
  const entry = findEntry(doc, id)

  return entry ? viewOf(db, doc, entry) : null
}

/**
 * Lists every deployment entry for a team (any status, any environment) -
 * powers the "check progress" links on `/manage` so a request stays
 * reachable even after the requester navigates away or signs back in later.
 * Throws 404 for a non-member so existence isn't disclosed.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, userId: string}} params - `teamId` is the team's id or slug
 */
export async function listDeploymentsForTeam(db, { teamId: teamRef, userId }) {
  const teamId = await requireMember(db, teamRef, userId)

  if (!teamId) {
    throw Boom.notFound()
  }

  const docs = await db.collection('teamDeployments').find({ teamId }).toArray()

  return Promise.all(
    docs.flatMap((doc) =>
      (doc.deployments ?? []).map((entry) => viewOf(db, doc, entry))
    )
  )
}

/**
 * Platform Admin retry or reconcile, through the deployment's operation:
 * `retry` by its state (a failed apply gets a fresh apply, a `timed-out`
 * operation resumes from the state it left, a held write is resubmitted);
 * `reconcile` asks the worker to report what GitHub holds for it, whatever
 * its state. Retry is only for a failed or held deployment; reconcile is
 * for any. Both publish a command and return at once: the deployment's
 * states show the progress.
 * @param {import('mongodb').Db} db
 * @param {{id: string, actorUserId: string, kind: 'retry'|'reconcile'}} params
 * @param {{operations: ReturnType<typeof import('#/operations/operations-service.js').createOperationsService>}} deps
 */
export async function redispatchApply(
  db,
  { id, actorUserId, kind },
  { operations }
) {
  await requirePlatformAdmin(db, actorUserId)

  const located = await db
    .collection('teamDeployments')
    .findOne({ 'deployments.id': id })
  const entry = findEntry(located, id)
  const operationId = entry?.operation?.id ?? entry?.operationId
  const operation = operationId ? await findOperation(db, operationId) : null

  if (!operation) {
    throw Boom.notFound()
  }

  let written

  try {
    written =
      kind === 'retry'
        ? await operations.retry(operation)
        : await operations.reconcile(operation._id)
  } catch (error) {
    if (error.isBoom) {
      throw error
    }

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

  await auditDeployment(db, entry, {
    action: `teamDeployment.${kind}`,
    actorUserId,
    reason:
      written && written.state !== operation.state
        ? `${operation.state} -> ${written.state}`
        : null
  })

  const doc = await db
    .collection('teamDeployments')
    .findOne({ _id: located._id })

  return viewOf(db, doc, findEntry(doc, id))
}
