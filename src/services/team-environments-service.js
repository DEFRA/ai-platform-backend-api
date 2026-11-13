import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { requireTeamRole } from '#/common/helpers/auth/access.js'
import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { connectionDetailsOf } from '#/adapters/team-connection-details-registry.js'
import { requestedLimitsOf } from '#/operations/operation-items.js'
import { findTeamOperations } from '#/operations/operation-repository.js'
import { REMOVED } from '#/services/team-deployment-entries.js'
import { teamEnvironments, viewOf } from '#/services/team-deployment-service.js'
import {
  MAX_FEDERATIONS,
  federationViewOf,
  heldTrustKeys,
  liveFederationsOf
} from '#/services/team-federation-entries.js'
import { limitBoundsFor } from '#/services/team-limit-bounds.js'
import {
  clientSecretViewOf,
  clientSecretsOf,
  clientSecretsSummaryOf
} from '#/services/team-client-secrets.js'
import {
  MAX_OPERATIONS_LIMIT,
  viewsOf
} from '#/services/team-operations-service.js'
import { readTeamFiles, requireTeamId } from '#/services/team-service.js'

// What a team's members see of their team in each environment: the models
// they hold and how each change is going, the limits their team file holds,
// and the latest change. Every read carries the team's id; the team files
// come from `main` (the same read the Teams page uses), a failed read is
// `502 upstream-unavailable`, never "not set up".

/**
 * Refuses an environment this portal instance does not offer, as `404
 * environment-not-available` (a read of something that is not there).
 * @param {string} environment
 */
export function requireAvailableEnvironment(environment) {
  if (!teamEnvironments().includes(environment)) {
    throw boomWithCode(
      Boom.notFound,
      'This environment is not available yet',
      'environment-not-available'
    )
  }
}

/**
 * The team a member acts in, with its id and the role the actor holds. A team
 * nobody has, or one the actor is not a member of (refused and audited), is
 * `404`; `roleOptions` asks for more (an admin, with the action a refusal
 * names).
 * @param {import('mongodb').Db} db
 * @param {string} teamRef - the team's id or slug
 * @param {{userId: string}} actor
 * @param {{role?: 'member'|'admin', action?: string}} [roleOptions]
 * @returns {Promise<{teamId: string, role: string, team: {slug: string, name: string}}>}
 */
export async function findMemberTeam(db, teamRef, actor, roleOptions = {}) {
  const teamId = await requireTeamId(db, teamRef)
  const role = await requireTeamRole(db, actor, teamId, roleOptions)

  // The team exists: `requireTeamId` has just found it.
  const team = await db
    .collection('teams')
    .findOne(
      { _id: new ObjectId(teamId) },
      { projection: { slug: 1, name: 1 } }
    )

  return { teamId, role, team }
}

// Everything a read of some of a team's environments needs, fetched together:
// the team files, the deployment documents, whether each environment is
// paused, each one's latest operation, the team's open operations and its
// client secrets.
async function gather(
  db,
  { teamId, team, environments },
  { registry, controls }
) {
  const [files, docs, paused, latest, open, secrets] = await Promise.all([
    readTeamFiles(
      registry,
      team.slug,
      teamEnvironments().filter(
        (environment) => !environments.includes(environment)
      )
    ),
    db
      .collection('teamDeployments')
      .find({ teamId, environment: { $in: environments } })
      .toArray(),
    Promise.all(
      environments.map((environment) => controls.isPaused(environment))
    ),
    Promise.all(
      environments.map((environment) =>
        findTeamOperations(db, { teamId, environment, limit: 1 })
      )
    ),
    findTeamOperations(db, {
      teamId,
      status: 'open',
      limit: MAX_OPERATIONS_LIMIT
    }),
    clientSecretsOf(db, { teamId, environments })
  ])
  const operations = [...latest.flat(), ...open]
  const views = new Map(
    (await viewsOf(db, operations)).map((view) => [view.id, view])
  )

  return environments.map((environment, index) => ({
    environment,
    file: files.find((file) => file.environment === environment),
    doc: docs.find((doc) => doc.environment === environment),
    paused: paused[index],
    latest: latest[index][0] ?? null,
    open: open.filter((operation) => operation.environment === environment),
    secrets: secrets.get(environment),
    views
  }))
}

function limitsOf(file) {
  return file
    ? {
        tokensPerMinute: file.document.gateway?.limits?.tokensPerMinute ?? null,
        requestsPerMinute:
          file.document.gateway?.limits?.requestsPerMinute ?? null
      }
    : null
}

// The models the team has in the environment: every entry that is not
// removed, with the ready ones counted.
function modelsOf(doc) {
  const entries = (doc?.deployments ?? []).filter(
    ({ status }) => status !== REMOVED
  )

  return {
    entries,
    summary: {
      count: entries.filter(({ status }) => status === 'active').length,
      items: entries.map(({ id, modelSlug, status }) => ({
        id,
        modelSlug,
        status
      }))
    }
  }
}

function summaryOf({
  environment,
  file,
  doc,
  paused,
  latest,
  open,
  secrets,
  views
}) {
  return {
    environment,
    setUp: Boolean(file),
    paused,
    models: modelsOf(doc).summary,
    limits: limitsOf(file),
    // The places the team's registration holds: applications asked for and
    // not failed or removed, and any the team file holds already.
    applications: {
      used: heldTrustKeys(doc, file?.document).size,
      limit: MAX_FEDERATIONS
    },
    clientSecrets: clientSecretsSummaryOf(environment, secrets),
    latestOperation: latest ? views.get(latest._id) : null,
    inProgress: open.length > 0
  }
}

/**
 * Every environment this instance offers, for a member of the team, in the
 * order of `TEAM_ENVIRONMENTS`: whether the team has set it up, its models,
 * limits and latest change, and whether a change is in progress.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, actor: {userId: string}}} params - `teamId` is the team's id or slug
 * @param {{controls: {isPaused: (environment: string) => Promise<boolean>}, registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} deps
 * @returns {Promise<{team: {id: string, slug: string, name: string}, environments: object[]}>}
 */
export async function listTeamEnvironments(
  db,
  { teamId: teamRef, actor },
  { controls, registry = tenantOrchestratorRegistry }
) {
  const { teamId, team } = await findMemberTeam(db, teamRef, actor)
  const environments = await gather(
    db,
    { teamId, team, environments: teamEnvironments() },
    { registry, controls }
  )

  return {
    team: { id: teamId, slug: team.slug, name: team.name },
    environments: environments.map(summaryOf)
  }
}

/**
 * One environment in full, for a member of the team: its summary, the models
 * as the deployments read gives them, the bounds the limits may be changed
 * within, and the limits a change in progress will set. An environment this
 * instance does not offer is `404 environment-not-available`, after the
 * team's own checks, so a non-member learns nothing.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string, actor: {userId: string}}} params - `teamId` is the team's id or slug
 * @param {{controls: {isPaused: (environment: string) => Promise<boolean>}, registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} deps
 * @returns {Promise<object>}
 */
export async function getTeamEnvironment(
  db,
  { teamId: teamRef, environment, actor },
  { controls, registry = tenantOrchestratorRegistry }
) {
  const { teamId, team } = await findMemberTeam(db, teamRef, actor)

  requireAvailableEnvironment(environment)

  const [read] = await gather(
    db,
    { teamId, team, environments: [environment] },
    { registry, controls }
  )
  const { entries } = modelsOf(read.doc)
  const summary = summaryOf(read)

  return {
    ...summary,
    applications: {
      ...summary.applications,
      items: liveFederationsOf(read.doc).map(federationViewOf)
    },
    clientSecrets: {
      ...summary.clientSecrets,
      items: read.secrets.map((secret) => clientSecretViewOf(secret))
    },
    models: await Promise.all(
      entries.map((entry) => viewOf(db, read.doc, entry))
    ),
    limitBounds: read.file
      ? await limitBoundsFor(db, { environment, document: read.file.document })
      : null,
    // The newest open change that sets limits: what the team will have.
    pendingLimits:
      read.open
        .map(({ items }) => requestedLimitsOf(items ?? []))
        .find(Boolean) ?? null,
    // What an application needs to call the team's models, once there is a
    // registration to call them as.
    connection: read.file
      ? await connectionDetailsOf({ team, environment })
      : null
  }
}
