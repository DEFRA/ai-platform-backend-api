import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { requirePlatformAdmin } from '#/common/helpers/auth/access.js'
import { findOperation } from '#/operations/operation-repository.js'
import {
  ACTIVE,
  CHECKS_FAILED,
  COMMITTED,
  DEPLOYED,
  DEPLOYING,
  DEPLOY_FAILED,
  QUEUED,
  REMOVED,
  REQUESTED,
  TIMED_OUT,
  VERIFIED
} from '#/operations/operation-state-machine.js'
import { isRetryable } from '#/operations/operations-retry.js'
import { environmentRank } from '#/services/admin-team-service.js'
import { credentialStatusOf } from '#/services/credential-block.js'
import { TEAM_CREDENTIAL_FILTER } from '#/services/credential-common.js'
import { findModelBySlug } from '#/services/models-service.js'
import { REMOVING } from '#/services/team-deployment-entries.js'
import { teamEnvironments } from '#/services/team-deployment-service.js'
import { normaliseName } from '#/services/team-service.js'
import { statusOf } from '#/services/team-status.js'

/** Deployments on a page of the Platform Admin Deployments list (design F). */
export const ADMIN_DEPLOYMENTS_PAGE_SIZE = 25

/** What the list's Status filter takes, worst first. */
export const DEPLOYMENT_STATUS_FILTERS = Object.freeze([
  'needs-attention',
  'waiting',
  'setting-up',
  'removing',
  'ready'
])

/** What the list's Credential filter takes. */
export const CREDENTIAL_FILTERS = Object.freeze([
  'active',
  'disabled',
  'revoked',
  'none'
])

// The group a model's status falls in. A status this map does not know is a
// model still being set up, never a failure.
const GROUP_OF_STATUS = new Map([
  [CHECKS_FAILED, 'needs-attention'],
  [DEPLOY_FAILED, 'needs-attention'],
  [TIMED_OUT, 'needs-attention'],
  [QUEUED, 'waiting'],
  [REQUESTED, 'setting-up'],
  [COMMITTED, 'setting-up'],
  [DEPLOYING, 'setting-up'],
  [DEPLOYED, 'setting-up'],
  [VERIFIED, 'setting-up'],
  [REMOVING, 'removing'],
  [ACTIVE, 'ready']
])

// A model whose operation may be one a retry is accepted for.
const RETRY_CANDIDATES = new Set([DEPLOY_FAILED, TIMED_OUT, QUEUED])

function invalidQuery() {
  return boomWithCode(
    Boom.badRequest,
    'The environment, status, credential or page is not valid',
    'invalid-query'
  )
}

function deploymentNotFound() {
  return boomWithCode(
    Boom.notFound,
    'There is no deployment for this team in this environment',
    'deployment-not-found'
  )
}

// The models a team still has: a removed one is gone.
function liveEntries(doc) {
  return (doc.deployments ?? []).filter(({ status }) => status !== REMOVED)
}

function groupOf(status) {
  return GROUP_OF_STATUS.get(status) ?? 'setting-up'
}

// The worst state of a team's models in one environment.
function worstStatusOf(entries) {
  const groups = new Set(entries.map(({ status }) => groupOf(status)))

  return DEPLOYMENT_STATUS_FILTERS.find((group) => groups.has(group)) ?? 'ready'
}

// When a model last changed: the latest status it reached, else when it was
// activated or requested (entries from before the times were recorded).
function changedAtOf(entry) {
  const times = Object.values(entry.statusTimes ?? {})

  return times.length > 0
    ? times.reduce((latest, time) => (time > latest ? time : latest))
    : (entry.activatedAt ?? entry.createdAt ?? null)
}

function latestOf(times) {
  return times.reduce(
    (latest, time) => (latest === null || time > latest ? time : latest),
    null
  )
}

/**
 * One environment's `teamDeployments` documents, with only the fields the
 * list reads. Selected by the `{environment, teamId}` index.
 * @param {import('mongodb').Db} db
 * @param {string} environment
 */
export function deploymentDocumentsCursor(db, environment) {
  return db.collection('teamDeployments').find(
    { environment },
    {
      projection: {
        teamId: 1,
        environment: 1,
        adminBlocked: 1,
        adminBlockedAt: 1,
        'deployments.modelSlug': 1,
        'deployments.status': 1,
        'deployments.statusTimes': 1,
        'deployments.createdAt': 1,
        'deployments.activatedAt': 1
      }
    }
  )
}

/**
 * The credential records of teams in one environment (every environment when
 * none is given), status only: never a secret, key hint or external ID.
 * Selected by the `{teamId, environment, tier}` index.
 * @param {import('mongodb').Db} db
 * @param {{teamIds: string[], environment?: string}} query
 */
export function teamCredentialsCursor(db, { teamIds, environment }) {
  return db.collection('credentials').find(
    {
      teamId: { $in: teamIds },
      ...(environment && { environment }),
      ...TEAM_CREDENTIAL_FILTER
    },
    { projection: { teamId: 1, environment: 1, status: 1 } }
  )
}

function groupBy(items, keyOf) {
  const groups = new Map()

  for (const item of items) {
    const key = keyOf(item)

    groups.set(key, [...(groups.get(key) ?? []), item])
  }

  return groups
}

async function teamRecords(db, teamIds) {
  const ids = teamIds
    .filter((teamId) => ObjectId.isValid(teamId))
    .map((teamId) => new ObjectId(teamId))
  const teams = await db
    .collection('teams')
    .find(
      { _id: { $in: ids } },
      { projection: { name: 1, normalisedName: 1, status: 1 } }
    )
    .toArray()

  return new Map(teams.map((team) => [team._id.toString(), team]))
}

// A model's display name by slug; the slug itself for one the catalogue no
// longer holds.
async function modelNames(db, slugs) {
  const found = await Promise.all(
    [...slugs].map(async (slug) => [
      slug,
      (await findModelBySlug(db, slug))?.displayName ?? slug
    ])
  )

  return new Map(found)
}

function sortedModels(slugs, names) {
  return [...slugs]
    .map((slug) => ({ slug, name: names.get(slug) }))
    .sort(
      (a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug)
    )
}

function validated({ environment, status, credential, page }) {
  const environments = teamEnvironments()
  const chosen = environment ?? environments[0]

  if (
    !environments.includes(chosen) ||
    (status !== undefined && !DEPLOYMENT_STATUS_FILTERS.includes(status)) ||
    (credential !== undefined && !CREDENTIAL_FILTERS.includes(credential)) ||
    !Number.isInteger(page) ||
    page < 1
  ) {
    throw invalidQuery()
  }

  return { environments, environment: chosen }
}

function matches(row, { search, model, status, credential }) {
  return (
    (!search || row.normalisedName.includes(search)) &&
    (!model || row.models.some(({ slug }) => slug === model)) &&
    (!status || row.status === status) &&
    (!credential || row.credential === credential)
  )
}

function listRow({ doc, team, credentials, names }) {
  const entries = liveEntries(doc)
  const name = team?.name ?? doc.teamId

  return {
    normalisedName: team?.normalisedName ?? normaliseName(name),
    teamId: doc.teamId,
    teamName: name,
    environment: doc.environment,
    models: sortedModels(
      new Set(entries.map(({ modelSlug }) => modelSlug)),
      names
    ),
    status: worstStatusOf(entries),
    credential: credentialStatusOf(doc, credentials).status,
    lastChangedAt: latestOf(entries.map(changedAtOf).filter(Boolean))
  }
}

/**
 * One page of the deployments in one environment for a Platform Admin: a row
 * per team that still has a model there, by team name, with its models, the
 * worst state of them, its credential's state and when anything last changed.
 * `search` matches part of the team's name as it is normalised (case and
 * spaces do not matter) and is compared as text, never as a pattern. The
 * rows are built in memory: they are bounded by the number of teams, and
 * every read is by index.
 * @param {import('mongodb').Db} db
 * @param {{actor: object, environment?: string, search?: string, model?: string, status?: string, credential?: string, page?: number}} params - `actor` is the token's credentials; `environment` is the first configured one when not given
 * @returns {Promise<{deployments: object[], page: number, pageSize: number, total: number, environment: string, options: {environments: string[], models: Array<{slug: string, name: string}>}}>}
 */
export async function listTeamDeployments(
  db,
  { actor, environment, search, model, status, credential, page = 1 }
) {
  await requirePlatformAdmin(db, actor)

  const chosen = validated({ environment, status, credential, page })
  const docs = (
    await deploymentDocumentsCursor(db, chosen.environment).toArray()
  ).filter((doc) => liveEntries(doc).length > 0)
  const teamIds = docs.map(({ teamId }) => teamId)
  const [teams, credentials, names] = await Promise.all([
    teamRecords(db, teamIds),
    teamCredentialsCursor(db, {
      teamIds,
      environment: chosen.environment
    }).toArray(),
    modelNames(
      db,
      new Set(docs.flatMap((doc) => liveEntries(doc).map((e) => e.modelSlug)))
    )
  ])
  const credentialsByTeam = groupBy(credentials, ({ teamId }) => teamId)
  const rows = docs
    .map((doc) =>
      listRow({
        doc,
        team: teams.get(doc.teamId),
        credentials: credentialsByTeam.get(doc.teamId) ?? [],
        names
      })
    )
    .sort((a, b) => a.normalisedName.localeCompare(b.normalisedName))
  const wanted = rows.filter((row) =>
    matches(row, {
      search: search?.trim() ? normaliseName(search) : undefined,
      model,
      status,
      credential
    })
  )
  const start = (page - 1) * ADMIN_DEPLOYMENTS_PAGE_SIZE

  return {
    deployments: wanted
      .slice(start, start + ADMIN_DEPLOYMENTS_PAGE_SIZE)
      .map(({ normalisedName: _normalisedName, ...row }) => row),
    page,
    pageSize: ADMIN_DEPLOYMENTS_PAGE_SIZE,
    total: wanted.length,
    environment: chosen.environment,
    options: {
      environments: chosen.environments,
      models: sortedModels(
        new Set(rows.flatMap((row) => row.models.map(({ slug }) => slug))),
        names
      )
    }
  }
}

/**
 * The credential status of a team in one environment now, as the detail
 * shows it (`{status, blockedAt?}`), read from the database.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string}} target
 * @returns {Promise<{status: string, blockedAt?: string}>}
 */
export async function readCredentialStatus(db, { teamId, environment }) {
  const [doc, credentials] = await Promise.all([
    db
      .collection('teamDeployments')
      .findOne(
        { teamId, environment },
        { projection: { adminBlocked: 1, adminBlockedAt: 1 } }
      ),
    teamCredentialsCursor(db, { teamIds: [teamId], environment }).toArray()
  ])

  return credentialStatusOf(doc, credentials)
}

// Whether a retry is accepted for the model: decided by its operation, which
// is only read for a model whose state a retry could be for.
async function retryableOf(db, entry) {
  const operationId = entry.operation?.id ?? entry.operationId

  if (!RETRY_CANDIDATES.has(entry.status) || !operationId) {
    return false
  }

  const operation = await findOperation(db, operationId)

  return operation ? isRetryable(operation) : false
}

async function modelRow(db, entry, names) {
  return {
    id: entry.id,
    modelSlug: entry.modelSlug,
    modelName: names.get(entry.modelSlug),
    status: entry.status,
    detail: entry.failureReason ?? null,
    updatedAt: changedAtOf(entry),
    retryable: await retryableOf(db, entry)
  }
}

/**
 * The team's document for an environment and the team, for a Platform Admin
 * who has already been shown to hold the right: a team or an environment the
 * instance does not list is `404 deployment-not-found`, as is a team with no
 * document there.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string}} target
 * @returns {Promise<{doc: object, team: object}>}
 */
export async function findTeamDeployment(db, { teamId, environment }) {
  if (!teamEnvironments().includes(environment) || !ObjectId.isValid(teamId)) {
    throw deploymentNotFound()
  }

  const [doc, team] = await Promise.all([
    db.collection('teamDeployments').findOne({ teamId, environment }),
    db.collection('teams').findOne({ _id: new ObjectId(teamId) })
  ])

  if (!doc || !team) {
    throw deploymentNotFound()
  }

  return { doc, team }
}

/**
 * One team's deployments in one environment for a Platform Admin: the team,
 * the worst state, the credential's state (never a secret, key hint or
 * external ID), each model with whether a retry would be accepted, and the
 * credential state in each of the team's environments.
 * @param {import('mongodb').Db} db
 * @param {{actor: object, teamId: string, environment: string}} params - `actor` is the token's credentials
 * @returns {Promise<object>}
 */
export async function getTeamDeployment(db, { actor, teamId, environment }) {
  await requirePlatformAdmin(db, actor, {
    resource: 'teamDeployment',
    resourceId: teamId
  })

  const { doc, team } = await findTeamDeployment(db, { teamId, environment })
  const [memberCount, docs, credentials] = await Promise.all([
    db.collection('teamMembers').countDocuments({ teamId, status: 'active' }),
    db
      .collection('teamDeployments')
      .find(
        { teamId },
        { projection: { environment: 1, adminBlocked: 1, adminBlockedAt: 1 } }
      )
      .toArray(),
    teamCredentialsCursor(db, { teamIds: [teamId] }).toArray()
  ])
  const entries = liveEntries(doc)
  const names = await modelNames(db, new Set(entries.map((e) => e.modelSlug)))
  const credentialsByEnvironment = groupBy(
    credentials,
    ({ environment: where }) => where
  )
  const credentialIn = (where) =>
    credentialStatusOf(
      where === doc.environment
        ? doc
        : docs.find((d) => d.environment === where),
      credentialsByEnvironment.get(where) ?? []
    )

  return {
    team: {
      id: teamId,
      name: team.name,
      status: statusOf(team),
      memberCount
    },
    environment,
    status: worstStatusOf(entries),
    credential: credentialIn(environment),
    deployments: await Promise.all(
      entries.map((entry) => modelRow(db, entry, names))
    ),
    environments: docs
      .map((d) => d.environment)
      .sort(
        (a, b) => environmentRank(a) - environmentRank(b) || a.localeCompare(b)
      )
      .map((where) => ({ environment: where, credential: credentialIn(where) }))
  }
}
