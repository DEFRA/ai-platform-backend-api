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
  })
})
