/**
 * Ordered registry of one-off data backfills applied by `runBackfills` on
 * every server start. Each entry is applied at most once per environment
 * (tracked in the `schemaMigrations` collection), so `run` only needs to be
 * idempotent against documents it hasn't reached yet - not against re-runs
 * of the whole backfill.
 *
 * Add a new entry when a schema change needs existing documents updated to
 * the new shape (the "backfill" step of expand -> backfill -> contract).
 * Keep entries after they've shipped - they double as a changelog of what
 * ran, and re-ordering/removing a shipped entry has no effect since its id
 * is already recorded as applied.
 *
 * @type {Array<{
 *   id: string,
 *   description: string,
 *   run: (db: import('mongodb').Db) => Promise<object|void>
 * }>}
 */
export const backfillRegistry = [
  // EXAMPLE - remove as required. Shows the expected shape: narrow the
  // filter to documents not yet migrated, use `updateMany`/`$set`, and
  // return a small summary for the schemaMigrations audit record.
  {
    id: '2026-09-25-example-add-schema-version',
    description: 'Example: sets schemaVersion on example-data docs missing it',
    async run(db) {
      const { modifiedCount } = await db
        .collection('example-data')
        .updateMany(
          { schemaVersion: { $exists: false } },
          { $set: { schemaVersion: 1 } }
        )

      return { modifiedCount }
    }
  },
  // `environment` was added to every credential doc when Route 2 introduced
  // team-tier credentials; research-tier credentials issued before that
  // never got the field (nothing reads it today, but a future query/report
  // filtering by environment would silently skip these docs otherwise).
  {
    id: '2026-09-25-credentials-environment-default',
    description: 'Sets environment: null on credentials docs missing it',
    async run(db) {
      const { modifiedCount } = await db
        .collection('credentials')
        .updateMany(
          { environment: { $exists: false } },
          { $set: { environment: null } }
        )

      return { modifiedCount }
    }
  }
]
