import { MongoClient } from 'mongodb'
import { LockManager } from 'mongo-locks'

import { config } from '#/config.js'
import { seedModels } from '#/common/seed/seed-models.js'

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

      await createIndexes(db)
      await seedModels(db, server.logger)

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

async function createIndexes(db) {
  await db.collection('mongo-locks').createIndex({ id: 1 })

  // Example of how to create a mongodb index. Remove as required
  await db.collection('example-data').createIndex({ id: 1 })

  await db.collection('models').createIndex({ slug: 1 }, { unique: true })
  await db.collection('users').createIndex({ email: 1 }, { unique: true })
  await db
    .collection('teams')
    .createIndex({ normalisedName: 1 }, { unique: true })
  // Makes the Idempotency-Key replay on POST /v1/teams atomic rather than
  // check-then-insert, so concurrent retries cannot create two teams.
  // Partial: excludes legacy/null idempotencyKey docs from the uniqueness check.
  await db.collection('teams').createIndex(
    { createdBy: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } }
    }
  )
  await db.collection('teamMembers').createIndex({ teamId: 1, userId: 1 })
  await db.collection('teamMembers').createIndex({ email: 1 })
  // Partial: the team creator's own admin membership carries a null email and
  // no idempotencyKey, so only invited members participate in these indexes.
  await db
    .collection('teamMembers')
    .createIndex(
      { teamId: 1, email: 1 },
      { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
    )
  await db.collection('teamMembers').createIndex(
    { teamId: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } }
    }
  )
  await db
    .collection('teamDeployments')
    .createIndex({ teamId: 1, modelSlug: 1, environment: 1 }, { unique: true })
  await db.collection('teamDeployments').createIndex(
    { teamId: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } }
    }
  )
  // Partial: excludes legacy/null idempotencyKey docs from the uniqueness check.
  await db.collection('credentials').createIndex(
    { userId: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } }
    }
  )
  await db.collection('credentials').createIndex({ userId: 1, status: 1 })
  await db.collection('credentials').createIndex({ status: 1, expiresAt: 1 })

  await db.collection('auditEvents').createIndex({ actorUserId: 1, at: 1 })
  // `at` must be a BSON Date (not an ISO string) for this TTL index to expire documents
  await db
    .collection('auditEvents')
    .createIndex(
      { at: 1 },
      { expireAfterSeconds: config.get('audit.retentionDays') * 24 * 60 * 60 }
    )
}
