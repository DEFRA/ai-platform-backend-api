import { ObjectId } from 'mongodb'

import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { config } from '#/config.js'
import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { findModelBySlug } from '#/services/models-service.js'

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
// offered to the team tier with no team SKU is a catalogue error, and is
// refused the same way an ineligible model is.
function deploymentOf(model, environment) {
  const sku = model?.skus?.find((offer) => offer.tiers?.includes('team'))

  if (!sku) {
    throw boomWithCode(
      Boom.forbidden,
      'Model has no team tier SKU in the catalogue',
      'model-not-eligible'
    )
  }

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
    const team = ObjectId.isValid(teamId)
      ? await db.collection('teams').findOne({ _id: new ObjectId(teamId) })
      : null

    if (!team?.slug) {
      return null
    }

    const path = teamFilePath(environment, team.slug)
    const { document: current } =
      await registry.orchestrator.getCurrentDocument({ path })
    const expectedRevision = current?.revision ?? 0
    const held = current?.deployments ?? []
    const granted = current?.gateway?.allowedDeployments ?? []
    const model = change === 'add' ? await findModelBySlug(db, modelSlug) : null
    const deployment =
      change === 'add' ? deploymentOf(model, environment) : null

    const document = {
      ...(current?.$schema ? { $schema: current.$schema } : {}),
      schemaVersion: SCHEMA_VERSION,
      revision: expectedRevision + 1,
      environment,
      status: 'active',
      ...(current?.promotedFrom ? { promotedFrom: current.promotedFrom } : {}),
      team: teamFields(team),
      deployments:
        change === 'remove'
          ? held.filter((entry) => entry.slug !== modelSlug)
          : held.some((entry) => entry.slug === deployment.slug)
            ? held
            : [...held, deployment],
      gateway: {
        credentialType: 'oauth',
        allowedDeployments:
          change === 'remove'
            ? granted.filter((slug) => slug !== modelSlug)
            : [...new Set([...granted, modelSlug])],
        // A team's agreed limits are never overwritten by a later request;
        // a removal keeps them even when the catalogue has moved on.
        limits: current?.gateway?.limits ?? limitsOf(model ?? {})
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
