import { MongoClient } from 'mongodb'

import { uuidv7 } from '#/common/helpers/uuid-v7.js'
import {
  claimOutboxEntry,
  compareAndSet,
  createOperationIndexes,
  findByIdempotencyKey,
  findOperation,
  findOverdue,
  findPendingOutbox,
  findSlotHolder,
  findVerificationDue,
  insertOperation,
  isDuplicateKey,
  markOutboxPublished
} from '#/operations/operation-repository.js'

function newOperation(overrides = {}) {
  // The driver stores an undefined field as null, so a field a test wants
  // absent is dropped here.
  return Object.fromEntries(
    Object.entries({
      _id: uuidv7(),
      type: 'team-file.write',
      teamId: 'team-1',
      environment: 'infradev',
      state: 'requested',
      stateVersion: 0,
      attempt: 1,
      slot: 'active',
      idempotencyKeys: [uuidv7()],
      history: [],
      outbox: [],
      outboxPending: false,
      ...overrides
    }).filter(([, value]) => value !== undefined)
  )
}

describe('#operation-repository', () => {
  let client
  let db

  beforeAll(async () => {
    client = await MongoClient.connect(process.env.MONGO_URI)
    db = client.db('operation-repository-test')
    await createOperationIndexes(db)
  })

  afterAll(async () => {
    await client.db('operation-repository-test').dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    await db.collection('operations').deleteMany({})
  })

  describe('indexes', () => {
    test('are safe to create twice', async () => {
      await expect(createOperationIndexes(db)).resolves.toBeUndefined()
    })

    test('allow one active and one waiting operation per file, and no more', async () => {
      await insertOperation(db, newOperation())
      await insertOperation(
        db,
        newOperation({ slot: 'waiting', state: 'queued' })
      )

      await expect(insertOperation(db, newOperation())).rejects.toSatisfy(
        isDuplicateKey
      )
      await expect(
        insertOperation(db, newOperation({ slot: 'waiting' }))
      ).rejects.toSatisfy(isDuplicateKey)
    })

    test('give another file, environment or team its own slots', async () => {
      await insertOperation(db, newOperation())
      await insertOperation(db, newOperation({ teamId: 'team-2' }))
      await insertOperation(db, newOperation({ environment: 'sandbox' }))

      expect(await db.collection('operations').countDocuments()).toBe(3)
    })

    test('free the slot when the operation ends and the field is removed', async () => {
      const first = await insertOperation(db, newOperation())

      await compareAndSet(db, first, { unset: ['slot'] })
      await insertOperation(db, newOperation())

      expect(await db.collection('operations').countDocuments()).toBe(2)
    })

    test('find a replayed idempotency key, including a merged request’s', async () => {
      const operation = await insertOperation(
        db,
        newOperation({ idempotencyKeys: ['key-a', 'key-b'], slot: undefined })
      )

      await expect(
        insertOperation(
          db,
          newOperation({ idempotencyKeys: ['key-b'], slot: undefined })
        )
      ).rejects.toSatisfy(isDuplicateKey)
      expect(
        (await findByIdempotencyKey(db, { teamId: 'team-1', key: 'key-b' }))._id
      ).toBe(operation._id)
      expect(
        await findByIdempotencyKey(db, { teamId: 'team-2', key: 'key-b' })
      ).toBeNull()
    })

    test('let operations with no keys or slot coexist (external, revert)', async () => {
      await insertOperation(
        db,
        newOperation({ idempotencyKeys: undefined, slot: undefined })
      )
      await insertOperation(
        db,
        newOperation({ idempotencyKeys: undefined, slot: undefined })
      )

      expect(await db.collection('operations').countDocuments()).toBe(2)
    })

    test('record an external run once', async () => {
      const external = {
        externalKey: 'DEFRA/ai-platform-tenants:25000000010',
        slot: undefined,
        idempotencyKeys: undefined
      }

      await insertOperation(db, newOperation(external))

      await expect(
        insertOperation(db, newOperation(external))
      ).rejects.toSatisfy(isDuplicateKey)
    })
  })

  describe('compare-and-set', () => {
    test('writes, bumps the version and returns the operation as written', async () => {
      const operation = await insertOperation(db, newOperation())

      const written = await compareAndSet(db, operation, {
        set: { state: 'committed' },
        push: { history: { state: 'committed' } },
        addToSet: { idempotencyKeys: 'extra' }
      })

      expect(written).toMatchObject({
        state: 'committed',
        stateVersion: 1,
        history: [{ state: 'committed' }]
      })
      expect(written.idempotencyKeys).toContain('extra')
      expect(await findOperation(db, operation._id)).toMatchObject({
        stateVersion: 1
      })
    })

    test('of two racing writers on the same read, exactly one wins', async () => {
      const operation = await insertOperation(db, newOperation())

      const results = await Promise.all(
        ['committed', 'deploying', 'deployed', 'active'].map((state) =>
          compareAndSet(db, operation, { set: { state } })
        )
      )

      expect(results.filter(Boolean)).toHaveLength(1)
      expect((await findOperation(db, operation._id)).stateVersion).toBe(1)
    })

    test('writes nothing for a read that has gone stale', async () => {
      const operation = await insertOperation(db, newOperation())

      await compareAndSet(db, operation, { set: { state: 'committed' } })

      expect(
        await compareAndSet(db, operation, { set: { state: 'requested' } })
      ).toBeNull()
      expect((await findOperation(db, operation._id)).state).toBe('committed')
    })
  })

  describe('the outbox', () => {
    const entry = (commandId) => ({
      commandId,
      type: 'submit',
      attempt: 1,
      claimedUntil: null,
      publishedAt: null
    })

    test('is claimed by one of two instances, and again once the lease expires', async () => {
      const operation = await insertOperation(
        db,
        newOperation({ outbox: [entry('c-1')], outboxPending: true })
      )
      const claim = (now) =>
        claimOutboxEntry(db, {
          operationId: operation._id,
          commandId: 'c-1',
          leaseMs: 30000,
          now
        })

      const first = await Promise.all([claim(1000), claim(1000)])

      expect(first.filter(Boolean)).toHaveLength(1)
      expect(await claim(20000)).toBe(false)
      expect(await claim(31001)).toBe(true)
    })

    test('is not claimable once published, and publishing clears the pending flag when none is left', async () => {
      const operation = await insertOperation(
        db,
        newOperation({
          outbox: [entry('c-1'), entry('c-2')],
          outboxPending: true
        })
      )

      await markOutboxPublished(db, {
        operationId: operation._id,
        commandId: 'c-1'
      })

      expect((await findPendingOutbox(db)).map(({ _id }) => _id)).toEqual([
        operation._id
      ])

      await markOutboxPublished(db, {
        operationId: operation._id,
        commandId: 'c-2'
      })

      expect(await findPendingOutbox(db)).toEqual([])
      expect(
        await claimOutboxEntry(db, {
          operationId: operation._id,
          commandId: 'c-1',
          leaseMs: 1
        })
      ).toBe(false)
    })
  })

  describe('the sweeps', () => {
    test('find overdue operations that hold a slot, oldest first', async () => {
      const now = Date.parse('2026-10-26T12:00:00Z')

      await insertOperation(
        db,
        newOperation({ teamId: 'a', deadlineAt: '2026-10-26T11:00:00.000Z' })
      )
      await insertOperation(
        db,
        newOperation({ teamId: 'b', deadlineAt: '2026-10-26T10:00:00.000Z' })
      )
      await insertOperation(
        db,
        newOperation({ teamId: 'c', deadlineAt: '2026-10-26T13:00:00.000Z' })
      )
      await insertOperation(
        db,
        newOperation({
          teamId: 'd',
          deadlineAt: '2026-10-26T09:00:00.000Z',
          slot: undefined
        })
      )

      const overdue = await findOverdue(db, { now })

      expect(overdue.map(({ teamId }) => teamId)).toEqual(['b', 'a'])
    })

    test('find deployed operations whose verification retry is due', async () => {
      const now = Date.parse('2026-10-26T12:00:00Z')

      await insertOperation(
        db,
        newOperation({
          teamId: 'a',
          state: 'deployed',
          verify: { attempts: 1, nextAt: '2026-10-26T11:59:30.000Z' }
        })
      )
      await insertOperation(
        db,
        newOperation({
          teamId: 'b',
          state: 'deployed',
          verify: { attempts: 1, nextAt: '2026-10-26T12:05:00.000Z' }
        })
      )

      expect(
        (await findVerificationDue(db, { now })).map(({ teamId }) => teamId)
      ).toEqual(['a'])
    })

    test('find the slot holder of a file', async () => {
      const operation = await insertOperation(db, newOperation())

      expect(
        (
          await findSlotHolder(db, {
            environment: 'infradev',
            teamId: 'team-1',
            slot: 'active'
          })
        )._id
      ).toBe(operation._id)
      expect(
        await findSlotHolder(db, {
          environment: 'infradev',
          teamId: 'team-1',
          slot: 'waiting'
        })
      ).toBeNull()
    })
  })
})
