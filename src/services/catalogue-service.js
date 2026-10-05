import { invalidateModelsCache } from '#/services/models-service.js'

// Pinned data-plane api-version per apiProfile, verified against the sandbox
// gateway (docs/plans/integration/research-tier-integration-plan.md in
// ai-platform-frontend): `responses` 404s on the chat-completions default.
const DEFAULT_API_VERSION_BY_PROFILE = { responses: '2025-03-01-preview' }
const DEFAULT_API_VERSION = '2024-05-01-preview'

// The github source passes `ai-platform-infra`'s raw catalogue/models/*.json
// through unmodified (pinned by its own tests), which nests eligibility as
// `{eligibility: {eligible, reason}}`, only carries a `regions` array, and
// has no `apiVersion` field at all - whereas the rest of this codebase
// (queries, routes, the frontend) reads flat `eligible`/`eligibilityReason`/
// `region`/`apiVersion`, the shape the file fixture already uses. Normalise
// here, at the single write path both sources go through, rather than
// changing either adapter's pinned output shape.
function normalizeModel(model) {
  return {
    ...model,
    eligible: model.eligible ?? model.eligibility?.eligible,
    eligibilityReason: model.eligibilityReason ?? model.eligibility?.reason,
    region: model.region ?? model.regions?.[0],
    apiVersion:
      model.apiVersion ??
      DEFAULT_API_VERSION_BY_PROFILE[model.apiProfile] ??
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

    for (const rawModel of models) {
      const model = normalizeModel(rawModel)
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
      `Synced ${models.length} catalogue models (release ${release}), retired ${retired}`
    )

    return { synced: models.length, retired }
  } finally {
    await lock.free()
  }
}
