import { Db, MongoClient } from 'mongodb'
import { LockManager } from 'mongo-locks'

describe('#mongoDb', () => {
  let server

  describe('Set up', () => {
    beforeAll(async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
    })

    test('Server should have expected MongoDb decorators', () => {
      expect(server.db).toBeInstanceOf(Db)
      expect(server.mongoClient).toBeInstanceOf(MongoClient)
      expect(server.locker).toBeInstanceOf(LockManager)
    })

    test('MongoDb should have expected database name', () => {
      expect(server.db.databaseName).toBe('ai-platform-backend-api')
    })

    test('MongoDb should have expected namespace', () => {
      expect(server.db.namespace).toBe('ai-platform-backend-api')
    })
  })

  describe('Shut down', () => {
    beforeAll(async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
    })

    test('Should close Mongo client on server stop', async () => {
      const closeSpy = vi.spyOn(server.mongoClient, 'close')
      await server.stop({ timeout: 1000 })

      expect(closeSpy).toHaveBeenCalledWith(true)
    })
  })

  describe('Stale index recovery', () => {
    test('rebuilds a non-partial idempotencyKey index left by an older deploy', async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { config } = await import('#/config.js')
      const client = await MongoClient.connect(config.get('mongo.mongoUrl'))
      const db = client.db(config.get('mongo.databaseName'))

      // Simulate a legacy index built before partialFilterExpression existed
      await db.collection('teams').dropIndex('createdBy_1_idempotencyKey_1')
      await db
        .collection('teams')
        .createIndex({ createdBy: 1, idempotencyKey: 1 }, { unique: true })

      const { createServer } = await import('#/server.js')
      const recoveredServer = await createServer()
      await recoveredServer.initialize()

      const indexes = await db.collection('teams').indexes()
      const rebuilt = indexes.find(
        (index) => index.name === 'createdBy_1_idempotencyKey_1'
      )
      expect(rebuilt.partialFilterExpression).toEqual({
        idempotencyKey: { $type: 'string' }
      })

      await recoveredServer.stop({ timeout: 1000 })
      await client.close()
    })

    test('replaces the adapter/status credentials index with gateway/status', async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { config } = await import('#/config.js')
      const client = await MongoClient.connect(config.get('mongo.mongoUrl'))
      const db = client.db(config.get('mongo.databaseName'))

      await db.collection('credentials').dropIndex('gateway_1_status_1')
      await db.collection('credentials').createIndex({ adapter: 1, status: 1 })

      const { createServer } = await import('#/server.js')
      const migratedServer = await createServer()
      await migratedServer.initialize()

      const names = (await db.collection('credentials').indexes()).map(
        (index) => index.name
      )
      expect(names).toContain('gateway_1_status_1')
      expect(names).not.toContain('adapter_1_status_1')

      await migratedServer.stop({ timeout: 1000 })
      await client.close()
    })

    test('keys users on oid and tid and rebuilds the unique email index as display only', async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { config } = await import('#/config.js')
      const client = await MongoClient.connect(config.get('mongo.mongoUrl'))
      const db = client.db(config.get('mongo.databaseName'))

      // An older deploy's unique email index; it cannot build over the
      // repeated emails other suites now create, so start with no users.
      await db.collection('users').deleteMany({})
      await db.collection('users').dropIndex('email_1')
      await db.collection('users').createIndex({ email: 1 }, { unique: true })

      const { createServer } = await import('#/server.js')
      const migratedServer = await createServer()
      await migratedServer.initialize()

      const indexes = await db.collection('users').indexes()

      expect(
        indexes.find((index) => index.name === 'email_1').unique
      ).toBeUndefined()
      expect(
        indexes.find((index) => index.name === 'oid_1_tid_1')
      ).toMatchObject({
        unique: true,
        partialFilterExpression: { oid: { $type: 'string' } }
      })

      await migratedServer.stop({ timeout: 1000 })
      await client.close()
    })
  })

  describe('Catalogue sync resilience', () => {
    afterEach(() => {
      vi.doUnmock('#/services/catalogue-service.js')
      vi.resetModules()
    })

    test('server still starts and decorates db/locker when catalogue sync fails', async () => {
      vi.doMock('#/services/catalogue-service.js', () => ({
        syncCatalogue: vi
          .fn()
          .mockRejectedValue(new Error('github unreachable'))
      }))

      // Dynamic import needed due to config being updated by vitest-mongodb and the mock above
      const { createServer } = await import('#/server.js')
      const failingServer = await createServer()

      await expect(failingServer.initialize()).resolves.not.toThrow()
      expect(failingServer.db).toBeInstanceOf(Db)
      expect(failingServer.locker).toBeInstanceOf(LockManager)

      await failingServer.stop({ timeout: 1000 })
    })
  })
})
