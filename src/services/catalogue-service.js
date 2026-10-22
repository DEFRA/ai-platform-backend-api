import { invalidateModelsCache, listModels } from '#/services/models-service.js'
import { readResearchDeployments } from '#/services/research-deployments.js'

// Pinned data-plane api-version per apiProfile, verified against the sandbox
// gateway (docs/plans/implemented/02-research-tier.md in
// ai-platform-frontend): `responses` 404s on the chat-completions default.
// Takes precedence over whatever the source supplies for that profile (see
// normalizeModel below) - a source has been seen shipping a stale generic
// apiVersion even on a model explicitly marked apiProfile: 'responses'.
const DEFAULT_API_VERSION_BY_PROFILE = { responses: '2025-03-01-preview' }
const DEFAULT_API_VERSION = '2024-05-01-preview'

const TEAM_TIER = 'team'
const RESEARCH_TIER = 'research'
const GLOBAL_SKU_PREFIX = 'global'

/**
 * The only regions a model may be deployed in, for every tier: UK South/West,
 * Sweden Central and EU North/West. The platform has no Global deployments,
 * so no other region (US, Asia, ...) is ever allowed. Compared
 * case-insensitively.
 * @type {readonly string[]}
 */
export const ALLOWED_REGIONS = Object.freeze([
  'uksouth',
  'ukwest',
  'swedencentral',
  'northeurope',
  'westeurope'
])

/**
 * Whether a SKU is a Global deployment type (e.g. `GlobalStandard`,
 * `GlobalBatch`), whose data may be processed anywhere. Never usable by any
 * tier.
 * @param {{name?: string}|null|undefined} sku
 * @returns {boolean}
 */
export function isGlobalSku(sku) {
  return String(sku?.name ?? '')
    .toLowerCase()
    .startsWith(GLOBAL_SKU_PREFIX)
}

function inAllowedRegions(regions) {
  return (
    Array.isArray(regions) &&
    regions.length > 0 &&
    regions.every((region) =>
      ALLOWED_REGIONS.includes(String(region).toLowerCase())
    )
  )
}

/**
 * The one rule for whether a tier can use a SKU of a model (single source of
 * truth for team and research): the SKU lists the tier, is not Global, and
 * every region it is offered in (`sku.regions`, else the model's) is in
 * `ALLOWED_REGIONS`, with at least one.
 * @param {{skus?: Array<{name: string, tiers?: string[], regions?: string[]}>, regions?: string[]}|null|undefined} model
 * @param {string} tier
 * @returns {object|undefined} the first usable SKU
 */
function usableSkuOf(model, tier) {
  return model?.skus?.find(
    (sku) =>
      sku.tiers?.includes(tier) &&
      !isGlobalSku(sku) &&
      inAllowedRegions(sku.regions ?? model.regions)
  )
}

/**
 * The SKU a team's deployment of a model uses: the first one offered to the
 * `team` tier that is not Global and is only in `ALLOWED_REGIONS`. A SKU with
 * no `regions` takes the model's. Undefined when the model has none, however
 * the rest of the catalogue describes it.
 * @param {{skus?: Array<{name: string, tiers?: string[], regions?: string[]}>, regions?: string[]}|null|undefined} model
 * @returns {object|undefined}
 */
export function teamSkuOf(model) {
  return usableSkuOf(model, TEAM_TIER)
}

/**
 * The SKU a research (on-your-own) credential for a model uses: as
 * `teamSkuOf`, for the `research` tier.
 * @param {{skus?: Array<{name: string, tiers?: string[], regions?: string[]}>, regions?: string[]}|null|undefined} model
 * @returns {object|undefined}
 */
export function researchSkuOf(model) {
  return usableSkuOf(model, RESEARCH_TIER)
}

/**
 * Whether research can have a model: it is eligible, lists `research` in its
 * `tiers` and has a usable research SKU (`researchSkuOf`).
 * @param {object|null|undefined} model
 * @returns {boolean}
 */
export function isResearchEligible(model) {
  return (
    Boolean(model?.eligible) &&
    Boolean(model.tiers?.includes(RESEARCH_TIER)) &&
    researchSkuOf(model) !== undefined
  )
}

/**
 * The one rule for whether a team can have a model: it is eligible, has a
 * usable team SKU (`teamSkuOf`) and, when an environment is named, lists that
 * environment in its catalogue `environments`.
 * @param {object|null|undefined} model
 * @param {string} [environment]
 * @returns {boolean}
 */
export function isTeamEligible(model, environment) {
  return (
    Boolean(model?.eligible) &&
    teamSkuOf(model) !== undefined &&
    (environment === undefined ||
      Boolean(model.environments?.includes(environment)))
  )
}

/**
 * Lists the models a team can have, optionally for one environment and
 * provider. The plain model list is unchanged, so a page can still say why a
 * model is not offered to teams.
 * @param {import('mongodb').Db} db
 * @param {{provider?: string, environment?: string}} [filters]
 */
export async function listTeamModels(db, { provider, environment } = {}) {
  const models = await listModels(db, { provider })

  return models.filter((model) => isTeamEligible(model, environment))
}

/**
 * Whether research can really use a model: it is research-eligible (the
 * catalogue rule) and deployed in the research environment (`deployed`, from
 * `readResearchDeployments`), so a key for it reaches a deployment that exists.
 * @param {object|null|undefined} model
 * @param {ReadonlySet<string>} deployed - the slugs deployed for research
 * @returns {boolean}
 */
export function isResearchAvailable(model, deployed) {
  return isResearchEligible(model) && deployed.has(model.slug)
}

/**
 * Lists the models research can have, optionally for one provider: eligible
 * in the catalogue and deployed in the research environment
 * (`isResearchAvailable`). The plain model list is unchanged, so a page can
 * still say why a model is not offered.
 * @param {import('mongodb').Db} db
 * @param {{provider?: string}} [filters]
 * @throws {Error} `502 research-deployments-unavailable` when the deployed models cannot be read
 */
export async function listResearchModels(db, { provider } = {}) {
  const [models, deployed] = await Promise.all([
    listModels(db, { provider, tier: RESEARCH_TIER }),
    readResearchDeployments()
  ])

  return models.filter((model) => isResearchAvailable(model, deployed))
}

/**
 * The plain model list, each model with a flat `researchAvailable` boolean:
 * true only when `isResearchAvailable` (research-eligible and deployed in the
 * research environment), so a page need not work it out itself.
 * @param {import('mongodb').Db} db
 * @param {{provider?: string, tier?: string, includeIneligible?: boolean}} [filters]
 * @throws {Error} `502 research-deployments-unavailable` when the deployed models cannot be read
 */
export async function listModelsWithResearchAvailability(db, filters = {}) {
  const [models, deployed] = await Promise.all([
    listModels(db, filters),
    readResearchDeployments()
  ])

  return models.map((model) => ({
    ...model,
    researchAvailable: isResearchAvailable(model, deployed)
  }))
}

function normalizeOffering(offering) {
  return {
    id: offering.id,
    hosting: {
      platform: offering.hosting.platform,
      cloud: offering.hosting.cloud ?? null,
      provider: offering.hosting.provider ?? null
    },
    gateway: offering.gateway
  }
}

// `provider/offering` -> `{id, hosting, gateway}`, plus any offering id a
// provider lists more than once and any offering without `hosting.platform`
// or `gateway`.
function indexOfferings(providers) {
  const index = new Map()
  const problems = []

  for (const provider of providers) {
    for (const offering of provider.offerings ?? []) {
      const key = `${provider.id}/${offering.id}`

      if (!offering.hosting?.platform || !offering.gateway) {
        problems.push(`${key} (needs hosting.platform and gateway)`)
        continue
      }

      if (index.has(key)) {
        problems.push(`${key} (duplicate)`)
      }

      index.set(key, normalizeOffering(offering))
    }
  }

  return { index, problems }
}

// The github source passes `ai-platform-infra`'s raw catalogue/models/*.json
// through unmodified (pinned by its own tests), which nests eligibility as
// `{eligibility: {eligible, reason}}`, only carries a `regions` array, and
// has no `apiVersion` field at all - whereas the rest of this codebase
// (queries, routes, the frontend) reads flat `eligible`/`eligibilityReason`/
// `region`/`apiVersion`, the shape the file fixture already uses. Normalise
// here, at the single write path both sources go through, rather than
// changing either adapter's pinned output shape.
function normalizeModel(model, offering) {
  return {
    ...model,
    hosting: offering.hosting,
    gateway: offering.gateway,
    eligible: model.eligible ?? model.eligibility?.eligible,
    eligibilityReason: model.eligibilityReason ?? model.eligibility?.reason,
    region: model.region ?? model.regions?.[0],
    apiVersion:
      DEFAULT_API_VERSION_BY_PROFILE[model.apiProfile] ??
      model.apiVersion ??
      DEFAULT_API_VERSION
  }
}

/**
 * Syncs the model catalogue from a `CatalogueSource` into MongoDB: upserts
 * every model by slug with `catalogueSha`/`release`/`syncedAt`, and retires
 * (never deletes - credentials reference slugs) any model no longer present
 * in the source. Guarded by a `mongo-locks` lock so replicas starting at the
 * same time don't duplicate the work; a replica that misses the lock simply
 * skips, relying on whichever instance won.
 *
 * A source returning zero models is treated as a misconfiguration, not an
 * intentionally empty catalogue, and is skipped rather than retiring every
 * existing model - this matters today because `ai-platform-infra`'s
 * `catalogue/` is still empty.
 * @param {import('mongodb').Db} db
 * @param {import('#/adapters/catalogue-source.js').CatalogueSource} source
 * @param {import('mongo-locks').LockManager} locker
 * @param {import('pino').Logger} logger
 */
export async function syncCatalogue(db, source, locker, logger) {
  const lock = await locker.lock('catalogue-sync')

  if (!lock) {
    return { synced: 0, retired: 0, skipped: true }
  }

  try {
    const { models, providers, catalogueSha, release } =
      await source.fetchCatalogue()

    if (models.length === 0) {
      logger.warn(
        'Catalogue source returned zero models - skipping sync rather than retiring the existing catalogue'
      )
      return { synced: 0, retired: 0, skipped: true }
    }

    const { index: offerings, problems } = indexOfferings(providers)

    // Skip rather than throw: a throw would reach startup, whereas skipping
    // keeps the last good catalogue like every other guard here.
    if (problems.length > 0) {
      logger.error(
        `Catalogue has invalid offerings (${problems.join(', ')}) - skipping sync`
      )
      return { synced: 0, retired: 0, skipped: true }
    }

    const now = new Date().toISOString()
    const modelsCollection = db.collection('models')
    let synced = 0

    for (const rawModel of models) {
      const offering = offerings.get(
        `${rawModel.provider}/${rawModel.offering}`
      )

      // The offering supplies hosting and gateway, so a model must name one
      // the catalogue defines - keep the last good copy instead.
      if (!offering) {
        logger.warn(
          `Skipping catalogue model ${rawModel.slug}: unknown offering ${rawModel.provider}/${rawModel.offering}`
        )
        continue
      }

      const model = normalizeModel(rawModel, offering)

      synced++
      await modelsCollection.updateOne(
        { slug: model.slug },
        {
          $set: {
            ...model,
            catalogueSha,
            release,
            syncedAt: now,
            updatedAt: now
          }
        },
        { upsert: true }
      )
    }

    for (const { $schema, ...provider } of providers) {
      // `$schema` is editor metadata and a `$`-prefixed key Mongo rejects in `$set`.
      await db
        .collection('providers')
        .updateOne(
          { id: provider.id },
          { $set: { ...provider, catalogueSha, release, syncedAt: now } },
          { upsert: true }
        )
    }

    const seenSlugs = models.map((model) => model.slug)
    const { modifiedCount: retired } = await modelsCollection.updateMany(
      { slug: { $nin: seenSlugs }, 'lifecycle.status': { $ne: 'retired' } },
      {
        $set: {
          eligible: false,
          'lifecycle.status': 'retired',
          updatedAt: now
        }
      }
    )

    invalidateModelsCache()

    logger.info(
      `Synced ${synced} catalogue models (release ${release}), retired ${retired}`
    )

    return { synced, retired }
  } finally {
    await lock.free()
  }
}
