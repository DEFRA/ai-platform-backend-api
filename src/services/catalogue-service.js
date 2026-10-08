import { invalidateModelsCache } from '#/services/models-service.js'
import { DEFAULT_ADAPTER } from '#/adapters/adapter-keys.js'

// Pinned data-plane api-version per apiProfile, verified against the sandbox
// gateway (docs/plans/integration/research-tier-integration-plan.md in
// ai-platform-frontend): `responses` 404s on the chat-completions default.
// Takes precedence over whatever the source supplies for that profile (see
// normalizeModel below) - a source has been seen shipping a stale generic
// apiVersion even on a model explicitly marked apiProfile: 'responses'.
const DEFAULT_API_VERSION_BY_PROFILE = { responses: '2025-03-01-preview' }
const DEFAULT_API_VERSION = '2024-05-01-preview'

// Catalogue releases up to v0.1.1 predate `cloud`/`adapter` and were Azure-only.
const LEGACY_CLOUD = 'azure'

// `provider/offering` -> `{id, cloud, adapter}`; legacy releases list
// offerings as plain strings, which are indexed with the Azure defaults.
function indexOfferings(providers) {
  const index = new Map()

  for (const provider of providers) {
    for (const offering of provider.offerings ?? []) {
      const entry =
        typeof offering === 'string'
          ? { id: offering, cloud: LEGACY_CLOUD, adapter: DEFAULT_ADAPTER }
          : offering

      index.set(`${provider.id}/${entry.id}`, entry)
    }
  }

  return index
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
    cloud: model.cloud ?? offering?.cloud ?? LEGACY_CLOUD,
    adapter: model.adapter ?? offering?.adapter ?? DEFAULT_ADAPTER,
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

    const now = new Date().toISOString()
    const modelsCollection = db.collection('models')
    const offerings = indexOfferings(providers)
    let synced = 0

    for (const rawModel of models) {
      const offering = offerings.get(
        `${rawModel.provider}/${rawModel.offering}`
      )
      const model = normalizeModel(rawModel, offering)

      // A model naming a provider/offering the catalogue doesn't define would
      // otherwise fall back to Azure/APIM - keep the last good copy instead.
      if (rawModel.provider && rawModel.offering && !offering) {
        logger.warn(
          `Skipping catalogue model ${model.slug}: unknown offering ${rawModel.provider}/${rawModel.offering}`
        )
        continue
      }

      // A model contradicting its provider's offering would issue credentials
      // through the wrong cloud - keep the last good copy rather than sync it.
      if (
        offering &&
        (model.cloud !== offering.cloud || model.adapter !== offering.adapter)
      ) {
        logger.warn(
          `Skipping catalogue model ${model.slug}: cloud/adapter disagree with offering ${model.provider}/${model.offering}`
        )
        continue
      }

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

    for (const provider of providers) {
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
