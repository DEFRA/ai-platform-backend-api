import { MongoClient } from 'mongodb'
import { LockManager } from 'mongo-locks'

import { config } from '#/config.js'
import { createFileCatalogueSource } from '#/adapters/file-catalogue-source.js'
import { createGithubCatalogueSource } from '#/adapters/github/github-catalogue-source.js'
import { syncCatalogue } from '#/services/catalogue-service.js'
import { runBackfills } from '#/common/backfills/run-backfills.js'
import { createOperationIndexes } from '#/operations/operation-repository.js'

function resolveCatalogueSource() {
  return config.get('catalogue.source') === 'github'
    ? createGithubCatalogueSource()
    : createFileCatalogueSource()
}

export const mongoDb = {
  plugin: {
    name: 'mongodb',
    version: '1.0.0',
    register: async function (server, options) {
      server.logger.info('Setting up MongoDb')

      const client = await MongoClient.connect(options.mongoUrl, {
        ...options.mongoOptions
      })

      const databaseName = options.databaseName
      const db = client.db(databaseName)
      const locker = new LockManager(db.collection('mongo-locks'))

      // Backfills run before indexes are (re)created: several legacy
      // documents (pre-refactor `teamDeployments`/`credentials` rows) would
      // otherwise violate the new unique indexes created below, and the
      // backfill itself drops the legacy indexes those old rows relied on.
      await runBackfills(db, server.logger)
      await createIndexes(db)

      // A catalogue source outage (e.g. GitHub unreachable) must not crash
      // the whole server - the existing catalogue in Mongo stays usable.
      try {
        await syncCatalogue(db, resolveCatalogueSource(), locker, server.logger)
      } catch (error) {
        server.logger.error(error, 'Catalogue sync failed, continuing startup')
      }

      server.logger.info(`MongoDb connected to ${databaseName}`)

      server.decorate('server', 'mongoClient', client)
      server.decorate('server', 'db', db)
      server.decorate('server', 'locker', locker)
      server.decorate('request', 'db', () => db, { apply: true })
      server.decorate('request', 'locker', () => locker, { apply: true })

      server.events.on('stop', async () => {
        server.logger.info('Closing Mongo client')
        try {
          await client.close(true)
        } catch (e) {
          server.logger.error(e, 'failed to close mongo client')
        }
      })
    }
  }
}

// IndexOptionsConflict/IndexKeySpecsConflict: a stale index with the
// same auto-generated name already exists with different options (e.g. built
// before a partialFilterExpression was added) - drop and rebuild it instead of
// crashing the server on every startup.
const MONGO_INDEX_OPTIONS_CONFLICT = 85
const MONGO_INDEX_KEY_SPECS_CONFLICT = 86
const MONGO_STALE_INDEX_CODES = new Set([
  MONGO_INDEX_OPTIONS_CONFLICT,
  MONGO_INDEX_KEY_SPECS_CONFLICT
])

// IndexNotFound/NamespaceNotFound: nothing to drop (a fresh
// database, or an index already removed by a prior run) - not an error.
const MONGO_INDEX_NOT_FOUND = 27
const MONGO_NAMESPACE_NOT_FOUND = 26
const MONGO_NOTHING_TO_DROP_CODES = new Set([
  MONGO_INDEX_NOT_FOUND,
  MONGO_NAMESPACE_NOT_FOUND
])

async function ensureIndex(collection, keys, options) {
  try {
    await collection.createIndex(keys, options)
  } catch (error) {
    if (!MONGO_STALE_INDEX_CODES.has(error.code)) {
      throw error
    }

    const name = Object.entries(keys)
      .map(([field, direction]) => `${field}_${direction}`)
      .join('_')

    await collection.dropIndex(name)
    await collection.createIndex(keys, options)
  }
}

async function dropIndexIfExists(collection, name) {
  try {
    await collection.dropIndex(name)
  } catch (error) {
    if (!MONGO_NOTHING_TO_DROP_CODES.has(error.code)) {
      throw error
    }
  }
}

async function createIndexes(db) {
  await db.collection('mongo-locks').createIndex({ id: 1 })

  await db.collection('models').createIndex({ slug: 1 }, { unique: true })
  // Backs the provider filter on GET /v1/models and provider -> offering lookups.
  await db.collection('models').createIndex({ provider: 1, offering: 1 })
  // `syncCatalogue` upserts providers by `id`.
  await db.collection('providers').createIndex({ id: 1 }, { unique: true })
  // People are keyed on their Entra object and tenant IDs (design F).
  // Partial: a record with no `oid` (from before that keying; nothing binds
  // one now, and the 2026-11-03 backfill deletes them) stays out of the index.
  await db
    .collection('users')
    .createIndex(
      { oid: 1, tid: 1 },
      { unique: true, partialFilterExpression: { oid: { $type: 'string' } } }
    )
  // Not unique: email is display only, so a returning leaver (a new object
  // ID) or an email change never collides with another record. Rebuilds
  // the unique index older deploys created.
  await ensureIndex(db.collection('users'), { email: 1 }, {})
  await db
    .collection('teams')
    .createIndex({ normalisedName: 1 }, { unique: true })
  // The slug names the team's GitOps file and gateway API path, so it must be
  // unique across the platform. The `2026-10-14-add-team-slug` backfill gives
  // older teams one before this index is created.
  await ensureIndex(db.collection('teams'), { slug: 1 }, { unique: true })
  // The Platform Admin Teams list filters by status and pages by name.
  await db.collection('teams').createIndex({ status: 1, normalisedName: 1 })
  // Makes the Idempotency-Key replay on POST /v1/teams atomic rather than
  // check-then-insert, so concurrent retries cannot create two teams.
  // Partial: excludes legacy/null idempotencyKey docs from the uniqueness check.
  await ensureIndex(
    db.collection('teams'),
    { createdBy: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } }
    }
  )
  await db.collection('teamMembers').createIndex({ teamId: 1, userId: 1 })
  // Membership is by person, not email: these indexes served the invitations
  // (`2026-11-03-team-members-directory-only` removed them and the field).
  await dropIndexIfExists(db.collection('teamMembers'), 'email_1')
  await dropIndexIfExists(db.collection('teamMembers'), 'teamId_1_email_1')
  // A person is an active member of a team once: the index decides a race
  // between two adds. Keyed `{ userId, teamId }` so it never clashes with
  // `{ teamId, userId }` above, and a rollback still starts cleanly.
  await ensureIndex(
    db.collection('teamMembers'),
    { userId: 1, teamId: 1 },
    { unique: true, partialFilterExpression: { status: 'active' } }
  )
  await ensureIndex(
    db.collection('teamMembers'),
    { teamId: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } }
    }
  )
  await db
    .collection('teamDeployments')
    .createIndex({ teamId: 1, environment: 1 }, { unique: true })
  // The Platform Admin Deployments list reads one environment's documents.
  await db
    .collection('teamDeployments')
    .createIndex({ environment: 1, teamId: 1 })
  // Superseded by the index above once `deployments[]` consolidated every
  // legacy one-row-per-model document (see the backfill registry) - the
  // migration itself runs before this, so these are always safe to drop.
  await dropIndexIfExists(
    db.collection('teamDeployments'),
    'teamId_1_modelSlug_1_environment_1'
  )
  await dropIndexIfExists(
    db.collection('teamDeployments'),
    'teamId_1_idempotencyKey_1'
  )
  // Partial: excludes legacy/null idempotencyKey docs from the uniqueness check.
  await ensureIndex(
    db.collection('credentials'),
    { userId: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } }
    }
  )
  // The Platform Admin Deployments pages read a team's credential records in
  // one environment (the list reads a page of teams at once).
  await db
    .collection('credentials')
    .createIndex({ teamId: 1, environment: 1, tier: 1 })
  await db.collection('credentials').createIndex({ userId: 1, status: 1 })
  await db.collection('credentials').createIndex({ status: 1, expiresAt: 1 })
  // Per-gateway work (reconcile, bulk revoke) selects by gateway and status.
  await db.collection('credentials').createIndex({ gateway: 1, status: 1 })
  // Superseded by the gateway index above once the credentials-gateway backfill renamed the field.
  await dropIndexIfExists(db.collection('credentials'), 'adapter_1_status_1')

  await db.collection('auditEvents').createIndex({ actorUserId: 1, at: 1 })
  // The Platform Admin Audit log lists newest first, then by `_id`, with or
  // without a team: both indexes match that order, so a page is read in index
  // order and never sorted in memory.
  await db.collection('auditEvents').createIndex({ at: -1, _id: -1 })
  await db.collection('auditEvents').createIndex({ teamId: 1, at: -1, _id: -1 })
  await createOperationIndexes(db)
  // `at` must be a BSON Date (not an ISO string) for this TTL index to expire documents
  await db
    .collection('auditEvents')
    .createIndex(
      { at: 1 },
      { expireAfterSeconds: config.get('audit.retentionDays') * 24 * 60 * 60 }
    )
}
