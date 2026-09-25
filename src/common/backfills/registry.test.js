import { backfillRegistry } from '#/common/backfills/registry.js'

describe('#backfillRegistry', () => {
  let server
  let db

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  function findBackfill(id) {
    return backfillRegistry.find((backfill) => backfill.id === id)
  }

  describe('2026-09-25-credentials-environment-default', () => {
    test('sets environment: null on a credential doc missing it', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'legacy-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'active'
      })

      const { modifiedCount } = await findBackfill(
        '2026-09-25-credentials-environment-default'
      ).run(db)

      expect(modifiedCount).toBeGreaterThanOrEqual(1)
      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated.environment).toBeNull()
    })

    test('leaves a credential doc with an existing environment untouched', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'team-user',
        tier: 'team',
        environment: 'sandbox',
        status: 'active'
      })

      await findBackfill('2026-09-25-credentials-environment-default').run(db)

      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated.environment).toBe('sandbox')
    })
  })
})
