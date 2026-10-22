import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { config } from '#/config.js'
import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { findModelBySlug } from '#/services/models-service.js'
import { isTeamEligible, teamSkuOf } from '#/services/catalogue-service.js'

// WS6: builds the whole team file the submit workflow writes
// (`ai-platform-infra/schemas/team.schema.json`). The file holds no resource
// names - the naming module derives them from the team slug and the
// catalogue slug - and is written whole every time, so it is built from what
// `main` holds now rather than from the portal's own record.

const SERVICE_CODE_PATTERN = /^[A-Z0-9]{3}$/
const SCHEMA_VERSION = 1

/**
 * The team's file path in `ai-platform-tenants`.
 * @param {string} environment
 * @param {string} slug
 */
export function teamFilePath(environment, slug) {
  return `environments/${environment}/${slug}.json`
}

function teamFields(team) {
  const serviceCode = team.serviceCode?.trim().toUpperCase()

  if (!SERVICE_CODE_PATTERN.test(serviceCode ?? '')) {
    throw boomWithCode(
      Boom.conflict,
      'The team needs a three-character service code before its models can be provisioned',
      'service-code-required'
    )
  }

  return { slug: team.slug, serviceCode }
}

// The team tier's SKU and starting capacity for one catalogue model. A model
// a team cannot have (the catalogue service's one rule: eligible, a UK team
// SKU, listed for this environment) is refused as the request is.
function deploymentOf(model, environment) {
  if (!isTeamEligible(model, environment)) {
    throw boomWithCode(
      Boom.badRequest,
      'Model is not eligible for this environment',
      'model-not-eligible'
    )
  }

  const sku = teamSkuOf(model)
  const policy = model.capacityPolicy ?? {}

  return {
    slug: model.slug,
    sku: sku.name,
    capacity:
      policy.environments?.[environment]?.default ??
      policy.default ??
      sku.capacity ??
      1,
    status: 'active'
  }
}

function limitsOf(model) {
  return {
    tokensPerMinute: config.get('teamDeployment.defaultTokensPerMinute'),
    requestsPerMinute:
      model.limitsDefault?.requestsPerMinute ??
      config.get('teamDeployment.defaultRequestsPerMinute')
  }
}

// What an `add` or a `remove` changes in the file: the deployments list and
// the grants, nothing else. An add is idempotent for a slug already held.
function withModelAdded({ held, granted }, deployment) {
  return {
    deployments: held.some((entry) => entry.slug === deployment.slug)
      ? held
      : [...held, deployment],
    allowedDeployments: [...new Set([...granted, deployment.slug])]
  }
}

function withModelRemoved({ held, granted }, modelSlug) {
  return {
    deployments: held.filter((entry) => entry.slug !== modelSlug),
    allowedDeployments: granted.filter((slug) => slug !== modelSlug)
  }
}

// The fields a new file keeps from the one on `main`, when there is one.
function carriedOver(current) {
  return {
    ...(current?.$schema ? { $schema: current.$schema } : {}),
    ...(current?.promotedFrom ? { promotedFrom: current.promotedFrom } : {})
  }
}

async function findTeam(db, teamId) {
  if (!ObjectId.isValid(teamId)) {
    return null
  }

  return db.collection('teams').findOne({ _id: new ObjectId(teamId) })
}

/**
 * The team's tenant file in each environment this instance deploys to
 * (`TEAM_ENVIRONMENTS`, in order) that has one on `main`. Environments the
 * team has no file in are left out.
 * @param {import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry} registry
 * @param {string} slug - the team's slug
 * @param {string[]} [excluding] - environments not to read
 * @returns {Promise<Array<{environment: string, document: object}>>}
 */
export async function readTeamEnvironments(registry, slug, excluding = []) {
  const environments = config
    .get('teamDeployment.environments')
    .filter((environment) => !excluding.includes(environment))
  const files = await Promise.all(
    environments.map(async (environment) => {
      const { document } = await registry.orchestrator.getCurrentDocument({
        path: teamFilePath(environment, slug)
      })

      return { environment, document }
    })
  )

  return files.filter(({ document }) => document)
}

// A team's first environment sets the limits a later one starts with, so a
// team does not meet new limits it never agreed to when it moves on.
async function inheritedLimits(registry, slug, environment) {
  const files = await readTeamEnvironments(registry, slug, [environment])

  const first = files.find(({ document }) => document.gateway?.limits)

  return first?.document.gateway.limits
}

// The file's own limits when it has them (never overwritten by a later
// request, and kept by a removal even when the catalogue has moved on), else
// the team's first environment's, else the defaults.
async function limitsFor({ current, registry, team, environment, model }) {
  return (
    current?.gateway?.limits ??
    (await inheritedLimits(registry, team.slug, environment)) ??
    limitsOf(model ?? {})
  )
}

/**
 * Creates the WS6 builder the GitHub orchestrator submits with. Returns the
 * whole next revision of the team's file and the revision it was built from,
 * which `submit` compares with `main` and refuses as `revision-conflict` if
 * another change has landed meanwhile. `change` is `add` (the default) or
 * `remove`: a removal is the file without the model's deployment and grant,
 * which the next apply destroys (design C #deletion); it never touches the
 * team's other models, limits or OAuth block, and needs no eligible model,
 * so a deprecated or retired model can still be removed. `updatedBy` is left
 * out: the caller sets it to the requester's principal, which the workflow
 * requires to equal `requested_by`.
 * @param {{registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} [deps]
 */
export function createTeamDesiredStateBuilder({
  registry = tenantOrchestratorRegistry
} = {}) {
  return async function buildTeamDesiredState(
    db,
    { teamId, environment, modelSlug, operationId, change = 'add' }
  ) {
    const team = await findTeam(db, teamId)

    if (!team?.slug) {
      return null
    }

    const path = teamFilePath(environment, team.slug)
    const { document: current } =
      await registry.orchestrator.getCurrentDocument({ path })
    const expectedRevision = current?.revision ?? 0
    const models = {
      held: current?.deployments ?? [],
      granted: current?.gateway?.allowedDeployments ?? []
    }
    const model = change === 'add' ? await findModelBySlug(db, modelSlug) : null
    const { deployments, allowedDeployments } =
      change === 'remove'
        ? withModelRemoved(models, modelSlug)
        : withModelAdded(models, deploymentOf(model, environment))

    const document = {
      ...carriedOver(current),
      schemaVersion: SCHEMA_VERSION,
      revision: expectedRevision + 1,
      environment,
      status: 'active',
      team: teamFields(team),
      deployments,
      gateway: {
        credentialType: 'oauth',
        allowedDeployments,
        // A team's agreed limits are never overwritten by a later request;
        // a removal keeps them even when the catalogue has moved on. A team's
        // first request in an environment copies its first environment's.
        limits: await limitsFor({ current, registry, team, environment, model })
      },
      oauth: current?.oauth ?? {
        federations: [],
        externalClients: [],
        secretsAllowed: true
      },
      operationId,
      updatedAt: new Date().toISOString()
    }

    return { document, expectedRevision }
  }
}

/**
 * The builder new team deployments are submitted with.
 */
export const teamDesiredStateBuilder = createTeamDesiredStateBuilder()
