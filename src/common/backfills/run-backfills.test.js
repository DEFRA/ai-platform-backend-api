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

  test('reclaims and retries a stale claim left by an instance that died mid-run', async () => {
    const staleStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    await db.collection('schemaMigrations').insertOne({
      _id: 'test-backfill-stale',
      description: 'stale',
      startedAt: staleStartedAt
    })
    const run = vi.fn().mockResolvedValue({ ok: true })
    const registry = [{ id: 'test-backfill-stale', description: 'stale', run }]

    await runBackfills(db, server.logger, registry)

    expect(run).toHaveBeenCalledTimes(1)

    const record = await db
      .collection('schemaMigrations')
      .findOne({ _id: 'test-backfill-stale' })
    expect(record.appliedAt).toEqual(expect.any(String))
  })

  test('releases the claim so a failed run is retried on the next startup', async () => {
    const failingRun = vi.fn().mockRejectedValueOnce(new Error('boom'))
    const registry = [
      { id: 'test-backfill-failure', description: 'failure', run: failingRun }
    ]

    await expect(runBackfills(db, server.logger, registry)).rejects.toThrow(
      'boom'
    )

    const claimAfterFailure = await db
      .collection('schemaMigrations')
      .findOne({ _id: 'test-backfill-failure' })
    expect(claimAfterFailure).toBeNull()

    const succeedingRun = vi.fn().mockResolvedValue({ ok: true })
    registry[0].run = succeedingRun

    await runBackfills(db, server.logger, registry)

    expect(succeedingRun).toHaveBeenCalledTimes(1)
  })

  test('skips without throwing when a concurrent instance wins the claim race', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true })
    const registry = [{ id: 'test-backfill-race', description: 'race', run }]

    // Exercises the real duplicate-key race via the collection's unique
    // `_id` constraint - two genuine concurrent calls, no third-party mock.
    await Promise.all([
      runBackfills(db, server.logger, registry),
      runBackfills(db, server.logger, registry)
    ])

    expect(run).toHaveBeenCalledTimes(1)
  })

  test('rethrows an insertClaim error that is not a duplicate key conflict', async () => {
    const run = vi.fn()
    const registry = [{ id: 'test-backfill-error', description: 'error', run }]
    // A fake store owned by this codebase's own port shape, rather than
    // mocking the third-party mongodb `Collection` type.
    const store = {
      findClaim: vi.fn().mockResolvedValue(null),
      insertClaim: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('boom'), { code: 1 })),
      releaseClaim: vi.fn(),
      reclaimStaleClaim: vi.fn(),
      completeClaim: vi.fn()
    }

    await expect(
      runBackfills(db, server.logger, registry, store)
    ).rejects.toThrow('boom')
    expect(run).not.toHaveBeenCalled()
  })
})
