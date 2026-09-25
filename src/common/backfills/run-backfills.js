import { backfillRegistry } from '#/common/backfills/registry.js'

const DUPLICATE_KEY_ERROR = 11000
// A claim with no `appliedAt` after this long is assumed to belong to an
// instance that died mid-run (rather than one still legitimately running),
// so it's safe for the next startup to reclaim and retry it.
const STALE_CLAIM_MS = 10 * 60 * 1000

/**
 * Thin wrapper around the `schemaMigrations` collection so `runBackfills`
 * depends on a port this codebase owns rather than the MongoDB driver's
 * `Collection` type directly - lets tests substitute a fake store instead of
 * mocking a third-party type.
 * @param {import('mongodb').Db} db
 */
export function createSchemaMigrationsStore(db) {
  const collection = db.collection('schemaMigrations')

  return {
    findClaim: (id) => collection.findOne({ _id: id }),
    async insertClaim(id, description) {
      await collection.insertOne({
        _id: id,
        description,
        startedAt: new Date().toISOString()
      })
    },
    async releaseClaim(id) {
      await collection.deleteOne({ _id: id, appliedAt: { $exists: false } })
    },
    async reclaimStaleClaim(id, expectedStartedAt) {
      const { deletedCount } = await collection.deleteOne({
        _id: id,
        appliedAt: { $exists: false },
        startedAt: expectedStartedAt
      })

      return deletedCount > 0
    },
    async completeClaim(id, result) {
      await collection.updateOne(
        { _id: id },
        { $set: { appliedAt: new Date().toISOString(), result: result ?? null } }
      )
    }
  }
}

/**
 * Claims a backfill for this instance to run: a fresh id is claimed via an
 * `insertOne` keyed on its id (only one concurrent instance wins the
 * unique-key race), and a claim left behind by a crashed instance (no
 * `appliedAt`, older than `STALE_CLAIM_MS`) is reclaimed instead of skipped
 * forever.
 * @param {ReturnType<typeof createSchemaMigrationsStore>} store
 * @param {typeof backfillRegistry[number]} backfill
 */
async function claimBackfill(store, backfill) {
  const existing = await store.findClaim(backfill.id)

  if (existing?.appliedAt) {
    return false
  }

  if (existing && !existing.appliedAt) {
    const startedAt = new Date(existing.startedAt).getTime()

    if (Date.now() - startedAt <= STALE_CLAIM_MS) {
      return false // likely still running on another instance
    }

    const reclaimed = await store.reclaimStaleClaim(
      backfill.id,
      existing.startedAt
    )

    if (!reclaimed) {
      return false // another instance reclaimed or completed it first
    }
  }

  try {
    await store.insertClaim(backfill.id, backfill.description)
    return true
  } catch (error) {
    if (error.code === DUPLICATE_KEY_ERROR) {
      return false
    }
    throw error
  }
}

/**
 * Applies each not-yet-applied backfill from the registry exactly once,
 * recording completion in the `schemaMigrations` collection so re-running
 * on every deploy/restart is a no-op for backfills already applied.
 *
 * Concurrency-safe across multiple instances starting at once (see
 * `claimBackfill`), and recoverable on failure: a run that throws releases
 * its claim so the next startup retries it, and a claim left by a process
 * that died mid-run is reclaimed once it goes stale.
 * @param {import('mongodb').Db} db
 * @param {import('pino').Logger} logger
 * @param {typeof backfillRegistry} [registry]
 * @param {ReturnType<typeof createSchemaMigrationsStore>} [store]
 */
export async function runBackfills(
  db,
  logger,
  registry = backfillRegistry,
  store = createSchemaMigrationsStore(db)
) {
  for (const backfill of registry) {
    const claimed = await claimBackfill(store, backfill)
    if (!claimed) {
      continue
    }

    try {
      const result = await backfill.run(db)
      await store.completeClaim(backfill.id, result)
      logger.info(`Applied backfill "${backfill.id}": ${backfill.description}`)
    } catch (error) {
      await store.releaseClaim(backfill.id)
      throw error
    }
  }
}

