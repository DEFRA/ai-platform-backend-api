import { invalidateModelsCache } from '#/services/models-service.js'

// Pinned data-plane api-version per apiProfile, verified against the sandbox
// gateway (docs/plans/integration/research-tier-integration-plan.md in
// ai-platform-frontend): `responses` 404s on the chat-completions default.
// Takes precedence over whatever the source supplies for that profile (see
// normalizeModel below) - a source has been seen shipping a stale generic
// apiVersion even on a model explicitly marked apiProfile: 'responses'.
const DEFAULT_API_VERSION_BY_PROFILE = { responses: '2025-03-01-preview' }
const DEFAULT_API_VERSION = '2024-05-01-preview'

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
