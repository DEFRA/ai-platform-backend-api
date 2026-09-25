import { backfillRegistry } from '#/common/backfills/registry.js'

const DUPLICATE_KEY_ERROR = 11000

/**
 * Applies each not-yet-applied backfill from the registry exactly once,
 * recording completion in the `schemaMigrations` collection so re-running
 * on every deploy/restart is a no-op for backfills already applied.
 *
 * Concurrency-safe across multiple instances starting at once: claiming a
 * backfill is an `insertOne` keyed on its id, so only one instance wins the
 * unique-key race and runs it; the rest see the duplicate-key error and skip.
 * @param {import('mongodb').Db} db
 * @param {import('pino').Logger} logger
 * @param {typeof backfillRegistry} [registry]
 */
export async function runBackfills(db, logger, registry = backfillRegistry) {
  const collection = db.collection('schemaMigrations')

  for (const backfill of registry) {
    const alreadyClaimed = await collection.findOne({ _id: backfill.id })
    if (alreadyClaimed) {
      continue
    }

    try {
      await collection.insertOne({
        _id: backfill.id,
        description: backfill.description,
        startedAt: new Date().toISOString()
      })
    } catch (error) {
      if (error.code === DUPLICATE_KEY_ERROR) {
        continue
      }
      throw error
    }

    const result = await backfill.run(db)

    await collection.updateOne(
      { _id: backfill.id },
      { $set: { appliedAt: new Date().toISOString(), result: result ?? null } }
    )

    logger.info(`Applied backfill "${backfill.id}": ${backfill.description}`)
  }
}
