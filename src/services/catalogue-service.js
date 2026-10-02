import { invalidateModelsCache } from '#/services/models-service.js'

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

    for (const model of models) {
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
