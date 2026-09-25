import { Collection } from 'mongodb'

import { runBackfills } from '#/common/backfills/run-backfills.js'

describe('#runBackfills', () => {
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

  test('applies a not-yet-applied backfill and records it as applied', async () => {
    const run = vi.fn().mockResolvedValue({ modifiedCount: 3 })
    const registry = [{ id: 'test-backfill-apply', description: 'test', run }]

    await runBackfills(db, server.logger, registry)

    expect(run).toHaveBeenCalledTimes(1)

    const record = await db
      .collection('schemaMigrations')
      .findOne({ _id: 'test-backfill-apply' })
    expect(record.appliedAt).toEqual(expect.any(String))
    expect(record.result).toEqual({ modifiedCount: 3 })
  })

  test('does not reapply a backfill already recorded as applied', async () => {
    const run = vi.fn().mockResolvedValue({ modifiedCount: 0 })
    const registry = [{ id: 'test-backfill-apply', description: 'test', run }]

    await runBackfills(db, server.logger, registry)

    expect(run).not.toHaveBeenCalled()
  })

  test('skips a backfill claimed but not yet completed by another instance', async () => {
    await db.collection('schemaMigrations').insertOne({
      _id: 'test-backfill-claimed',
      description: 'claimed',
      startedAt: new Date().toISOString()
    })
    const run = vi.fn()
    const registry = [
      { id: 'test-backfill-claimed', description: 'claimed', run }
    ]

    await runBackfills(db, server.logger, registry)

    expect(run).not.toHaveBeenCalled()
  })

  test('skips without throwing when a concurrent instance wins the claim race', async () => {
    const insertSpy = vi
      .spyOn(Collection.prototype, 'insertOne')
      .mockRejectedValueOnce(
        Object.assign(new Error('duplicate'), { code: 11000 })
      )
    const run = vi.fn()
    const registry = [{ id: 'test-backfill-race', description: 'race', run }]

    await runBackfills(db, server.logger, registry)

    expect(run).not.toHaveBeenCalled()

    insertSpy.mockRestore()
  })

  test('rethrows an insertOne error that is not a duplicate key conflict', async () => {
    const insertSpy = vi
      .spyOn(Collection.prototype, 'insertOne')
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 1 }))
    const run = vi.fn()
    const registry = [{ id: 'test-backfill-error', description: 'error', run }]

    await expect(runBackfills(db, server.logger, registry)).rejects.toThrow(
      'boom'
    )
    expect(run).not.toHaveBeenCalled()

    insertSpy.mockRestore()
  })
})
