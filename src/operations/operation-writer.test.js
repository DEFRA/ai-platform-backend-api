import { MongoClient } from 'mongodb'

import { gitopsSettings } from '#/operations/gitops-settings.js'
import { buildOperation } from '#/operations/operation-factory.js'
import {
  compareAndSet,
  findOperation,
  insertOperation
} from '#/operations/operation-repository.js'
import {
  writeOperation,
  writeWithRetry
} from '#/operations/operation-writer.js'
import { SYSTEM_ACTOR } from '#/services/team-deployment-entries.js'

const DATABASE = 'operation-writer-test'
const OID = '00000000-0000-0000-0000-000000000001'
const ITEMS = [
  { entryId: 'entry-1', modelSlug: 'gpt-4o', change: 'add' },
  { entryId: 'entry-2', modelSlug: 'phi-4', change: 'add' }
]
const DEADLINES = {
  requested: 600000,
  committed: 1800000,
  deploying: 2700000,
  deployed: 900000
}

describe('operation-writer', () => {
  const settings = gitopsSettings({ deadlines: DEADLINES })
  let client
  let db

  async function seedOperation(overrides = {}) {
    const operation = {
      ...buildOperation({
        type: 'team-file.write',
        state: 'requested',
        teamId: 'team-1',
        environment: 'infradev',
        target: {
          repository: 'DEFRA/ai-platform-tenants',
          team: 'alpha',
          path: 'environments/infradev/alpha.json'
        },
        items: ITEMS,
        slot: 'active',
        requestedBy: `entra:${OID}`
      }),
      ...overrides
    }

    return insertOperation(db, operation)
  }

  function ctx(overrides = {}) {
    return { db, settings, logger: { warn: vi.fn() }, ...overrides }
  }

  function auditEvents() {
    return db
      .collection('auditEvents')
      .find({})
      .sort({ resourceId: 1 })
      .toArray()
  }

  // A database whose operations collection loses the first `losses` writes
  // to another writer, as a concurrent instance would.
  function racingDb(losses) {
    let remaining = losses

    return {
      collection(name) {
        const collection = db.collection(name)

        if (name === 'operations') {
          const original = collection.findOneAndUpdate.bind(collection)

          collection.findOneAndUpdate = async (filter, ...rest) => {
            if (remaining > 0) {
              remaining -= 1
              await collection.updateOne(
                { _id: filter._id },
                { $inc: { stateVersion: 1 } }
              )
            }

            return original(filter, ...rest)
          }
        }

        return collection
      }
    }
  }

  beforeAll(async () => {
    client = await MongoClient.connect(process.env.MONGO_URI)
    db = client.db(DATABASE)
  })

  afterAll(async () => {
    await client.db(DATABASE).dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    await db.collection('operations').deleteMany({})
    await db.collection('teamDeployments').deleteMany({})
    await db.collection('auditEvents').deleteMany({})
  })

  describe('writeOperation', () => {
    describe('a state change', () => {
      test('records the transition in the history with its source, event and event time', async () => {
        const operation = await seedOperation()

        const written = await writeOperation(ctx(), operation, {
          state: 'committed',
          source: 'submit',
          eventId: 'event-1',
          eventAt: '2026-10-26T12:00:05Z'
        })

        expect(written.state).toBe('committed')
        expect(written.stateVersion).toBe(1)
        expect(written.history).toHaveLength(2)
        expect(written.history[1]).toEqual({
          state: 'committed',
          at: '2026-10-26T12:00:05Z',
          receivedAt: expect.any(String),
          source: 'submit',
          eventId: 'event-1'
        })
        expect((await findOperation(db, operation._id)).state).toBe('committed')
      })

      test('records a backend transition with no event when none is named', async () => {
        const operation = await seedOperation()

        const written = await writeOperation(ctx(), operation, {
          state: 'committed'
        })
        const entry = written.history[1]

        expect(entry).toMatchObject({ source: 'backend', eventId: null })
        expect(entry.at).toBe(entry.receivedAt)
      })

      test('resets the reconcile count', async () => {
        const operation = await seedOperation({ reconcileCount: 1 })

        const written = await writeOperation(ctx(), operation, {
          state: 'committed'
        })

        expect(written.reconcileCount).toBe(0)
      })

      test('sets the deadline from the settings for the new state', async () => {
        const operation = await seedOperation()
        const before = Date.now()

        const written = await writeOperation(ctx(), operation, {
          state: 'deploying'
        })
        const deadline = Date.parse(written.deadlineAt)

        expect(deadline).toBeGreaterThanOrEqual(before + DEADLINES.deploying)
        expect(deadline).toBeLessThanOrEqual(Date.now() + DEADLINES.deploying)
      })

      test('has no deadline in a state the settings give none', async () => {
        const operation = await seedOperation({
          deadlineAt: '2026-10-26T12:00:00.000Z'
        })

        const written = await writeOperation(ctx(), operation, {
          state: 'verified'
        })

        expect(written.deadlineAt).toBeNull()
      })

      test('uses the deadline the change names over the state default', async () => {
        const operation = await seedOperation()

        const written = await writeOperation(ctx(), operation, {
          state: 'committed',
          deadlineAt: '2030-01-01T00:00:00.000Z'
        })

        expect(written.deadlineAt).toBe('2030-01-01T00:00:00.000Z')
      })

      test('clears the deadline when the change names null', async () => {
        const operation = await seedOperation({
          deadlineAt: '2030-01-01T00:00:00.000Z'
        })

        const written = await writeOperation(ctx(), operation, {
          state: 'committed',
          deadlineAt: null
        })

        expect(written.deadlineAt).toBeNull()
      })

      test('unsets the state a timed-out operation left when it moves on', async () => {
        const operation = await seedOperation({
          state: 'timed-out',
          leftState: 'deploying'
        })

        const written = await writeOperation(ctx(), operation, {
          state: 'deployed'
        })

        expect(written).not.toHaveProperty('leftState')
        expect(await findOperation(db, operation._id)).not.toHaveProperty(
          'leftState'
        )
      })

      test('keeps leftState when the operation was not timed out', async () => {
        const operation = await seedOperation({ leftState: 'deploying' })

        const written = await writeOperation(ctx(), operation, {
          state: 'committed'
        })

        expect(written.leftState).toBe('deploying')
      })

      test('adds the history entry to any push the change names', async () => {
        const operation = await seedOperation({ notes: [] })

        const written = await writeOperation(ctx(), operation, {
          state: 'committed',
          push: { notes: 'a note' }
        })

        expect(written.notes).toEqual(['a note'])
        expect(written.history).toHaveLength(2)
      })
    })

    describe('a change with no state', () => {
      test('writes the fields without a history entry, a new deadline or a reset count', async () => {
        const operation = await seedOperation({
          reconcileCount: 1,
          deadlineAt: '2030-01-01T00:00:00.000Z'
        })

        const written = await writeOperation(ctx(), operation, {
          set: { held: { reason: 'paused' } },
          unset: ['slot']
        })

        expect(written).toMatchObject({
          state: 'requested',
          stateVersion: 1,
          reconcileCount: 1,
          deadlineAt: '2030-01-01T00:00:00.000Z',
          held: { reason: 'paused' }
        })
        expect(written.history).toHaveLength(1)
        expect(written).not.toHaveProperty('slot')
      })

      test('writes no audit event', async () => {
        const operation = await seedOperation()

        await writeOperation(ctx(), operation, { set: { attempt: 2 } })

        expect(await auditEvents()).toEqual([])
      })

      test('adds to a set without recording a history entry', async () => {
        const operation = await seedOperation({ idempotencyKeys: ['key-1'] })

        const written = await writeOperation(ctx(), operation, {
          addToSet: { idempotencyKeys: 'key-2' }
        })

        expect(written.idempotencyKeys).toEqual(['key-1', 'key-2'])
        expect(written.history).toHaveLength(1)
      })

      test('stamps the update time', async () => {
        const operation = await seedOperation()

        const written = await writeOperation(ctx(), operation, {
          set: { attempt: 2 }
        })

        expect(written.updatedAt).not.toBe(operation.updatedAt)
        expect(Date.parse(written.updatedAt)).toBeGreaterThanOrEqual(
          Date.parse(operation.updatedAt)
        )
      })
    })

    describe('facts', () => {
      test('are written under gitops without losing the facts already held', async () => {
        const operation = await seedOperation({
          gitops: { submitRunId: 11, submitRunUrl: 'https://github.test/11' }
        })

        const written = await writeOperation(ctx(), operation, {
          state: 'committed',
          facts: { commitSha: 'abc123', committedAt: '2026-10-26T12:00:24Z' }
        })

        expect(written.gitops).toEqual({
          submitRunId: 11,
          submitRunUrl: 'https://github.test/11',
          commitSha: 'abc123',
          committedAt: '2026-10-26T12:00:24Z'
        })
      })

      test('replace a fact of the same name', async () => {
        const operation = await seedOperation({ gitops: { applyRunId: 10 } })

        const written = await writeOperation(ctx(), operation, {
          facts: { applyRunId: 12 }
        })

        expect(written.gitops.applyRunId).toBe(12)
      })

      test('let a field in set override a fact it names too', async () => {
        const operation = await seedOperation()

        const written = await writeOperation(ctx(), operation, {
          facts: { commitSha: 'from-facts' },
          set: { 'gitops.commitSha': 'from-set' }
        })

        expect(written.gitops.commitSha).toBe('from-set')
      })
    })

    describe('the projection', () => {
      test('is written onto the entries of the items after the change', async () => {
        await db.collection('teamDeployments').insertOne({
          teamId: 'team-1',
          environment: 'infradev',
          gateway: { allowedDeployments: [] },
          deployments: ITEMS.map(({ entryId, modelSlug }) => ({
            id: entryId,
            modelSlug,
            status: 'requested'
          }))
        })
        const operation = await seedOperation()

        await writeOperation(ctx(), operation, { state: 'committed' })

        const doc = await db.collection('teamDeployments').findOne({})

        expect(doc.deployments.map(({ status }) => status)).toEqual([
          'committed',
          'committed'
        ])
        expect(doc.deployments[0].operation).toMatchObject({
          id: operation._id,
          state: 'committed'
        })
      })
    })

    describe('the audit events', () => {
      test('record one transition per item, as the backend', async () => {
        const operation = await seedOperation()

        await writeOperation(ctx(), operation, { state: 'committed' })

        const events = await auditEvents()

        expect(events).toHaveLength(2)
        expect(events.map(({ resourceId }) => resourceId)).toEqual([
          'entry-1',
          'entry-2'
        ])
        expect(events[0]).toMatchObject({
          actorUserId: SYSTEM_ACTOR,
          action: 'teamDeployment.transition',
          resource: 'teamDeployment',
          outcome: 'success',
          code: 'committed',
          reason: 'requested -> committed'
        })
      })

      test.each(['checks-failed', 'deploy-failed', 'timed-out'])(
        'record a failure outcome for the state %s',
        async (state) => {
          const operation = await seedOperation()

          await writeOperation(ctx(), operation, { state })

          const events = await auditEvents()

          expect(events.map(({ outcome }) => outcome)).toEqual([
            'failure',
            'failure'
          ])
          expect(events[0].code).toBe(state)
        }
      )

      test('record a success outcome for a state that is not a failure', async () => {
        const operation = await seedOperation()

        await writeOperation(ctx(), operation, { state: 'active' })

        expect((await auditEvents())[0]).toMatchObject({
          outcome: 'success',
          code: 'active'
        })
      })

      test('use the action, outcome, code and reason the change names', async () => {
        const operation = await seedOperation()

        await writeOperation(ctx(), operation, {
          state: 'deploy-failed',
          audit: {
            action: 'teamDeployment.revert',
            outcome: 'success',
            code: 'operation-reverted',
            reason: 'reverted after a second failure'
          }
        })

        expect((await auditEvents())[0]).toMatchObject({
          action: 'teamDeployment.revert',
          outcome: 'success',
          code: 'operation-reverted',
          reason: 'reverted after a second failure'
        })
      })

      test('are not written for an operation with no items', async () => {
        const operation = await seedOperation({ items: undefined })

        const written = await writeOperation(ctx(), operation, {
          state: 'committed'
        })

        expect(written.state).toBe('committed')
        expect(await auditEvents()).toEqual([])
      })

      describe('when the audit write fails', () => {
        function failingAuditDb() {
          return {
            collection(name) {
              return name === 'auditEvents'
                ? {
                    insertOne: () => Promise.reject(new Error('audit is down'))
                  }
                : db.collection(name)
            }
          }
        }

        test('logs it for each item and keeps the transition', async () => {
          const operation = await seedOperation()
          const logger = { warn: vi.fn() }

          const written = await writeOperation(
            ctx({ db: failingAuditDb(), logger }),
            operation,
            { state: 'committed' }
          )

          expect(written.state).toBe('committed')
          expect((await findOperation(db, operation._id)).state).toBe(
            'committed'
          )
          expect(logger.warn).toHaveBeenCalledTimes(2)
          expect(logger.warn).toHaveBeenCalledWith(
            { operationId: operation._id, message: 'audit is down' },
            'The operation transition could not be audited'
          )
        })

        test('needs no logger', async () => {
          const operation = await seedOperation()

          const written = await writeOperation(
            { db: failingAuditDb(), settings },
            operation,
            { state: 'committed' }
          )

          expect(written.state).toBe('committed')
        })
      })
    })

    describe('when the operation has moved', () => {
      test('returns null and writes nothing', async () => {
        await db.collection('teamDeployments').insertOne({
          teamId: 'team-1',
          environment: 'infradev',
          gateway: { allowedDeployments: [] },
          deployments: [
            { id: 'entry-1', modelSlug: 'gpt-4o', status: 'requested' }
          ]
        })
        const stale = await seedOperation()

        await compareAndSet(db, stale, { set: { state: 'deploying' } })

        const written = await writeOperation(ctx(), stale, {
          state: 'committed',
          facts: { commitSha: 'abc123' }
        })
        const stored = await findOperation(db, stale._id)

        expect(written).toBeNull()
        expect(stored.state).toBe('deploying')
        expect(stored.stateVersion).toBe(1)
        expect(stored.history).toHaveLength(1)
        expect(stored.gitops).toEqual({})
        expect(await auditEvents()).toEqual([])
        expect(
          (await db.collection('teamDeployments').findOne({})).deployments[0]
            .status
        ).toBe('requested')
      })
    })
  })

  describe('writeWithRetry', () => {
    test('writes the change computed from the operation as read', async () => {
      const operation = await seedOperation()
      const changeOf = vi.fn((read) => ({
        state: 'committed',
        set: { seenVersion: read.stateVersion }
      }))

      const written = await writeWithRetry(ctx(), operation._id, changeOf)

      expect(changeOf).toHaveBeenCalledTimes(1)
      expect(changeOf.mock.calls[0][0]._id).toBe(operation._id)
      expect(written).toMatchObject({ state: 'committed', seenVersion: 0 })
    })

    test('reads again and tries again after losing a race', async () => {
      const operation = await seedOperation()
      const seen = []

      const written = await writeWithRetry(
        ctx({ db: racingDb(2) }),
        operation._id,
        (read) => {
          seen.push(read.stateVersion)

          return { state: 'committed' }
        }
      )

      expect(seen).toEqual([0, 1, 2])
      expect(written.state).toBe('committed')
      expect(written.stateVersion).toBe(3)
    })

    test('stops with null when the change is no longer needed after a lost race', async () => {
      const operation = await seedOperation()
      const changeOf = vi
        .fn()
        .mockReturnValueOnce({ state: 'committed' })
        .mockReturnValueOnce(null)

      const written = await writeWithRetry(
        ctx({ db: racingDb(1) }),
        operation._id,
        changeOf
      )
      const stored = await findOperation(db, operation._id)

      expect(written).toBeNull()
      expect(changeOf).toHaveBeenCalledTimes(2)
      expect(stored.state).toBe('requested')
      expect(stored.history).toHaveLength(1)
    })

    test('returns null without writing when there is nothing to do', async () => {
      const operation = await seedOperation()

      const written = await writeWithRetry(ctx(), operation._id, () => null)

      expect(written).toBeNull()
      expect((await findOperation(db, operation._id)).stateVersion).toBe(0)
    })

    test('returns null without asking for a change when the operation does not exist', async () => {
      const changeOf = vi.fn()

      const written = await writeWithRetry(ctx(), 'no-such-operation', changeOf)

      expect(written).toBeNull()
      expect(changeOf).not.toHaveBeenCalled()
    })

    test('throws once the attempts are used up, having written nothing', async () => {
      const operation = await seedOperation()
      const changeOf = vi.fn(() => ({ state: 'committed' }))

      await expect(
        writeWithRetry(ctx({ db: racingDb(10) }), operation._id, changeOf, 3)
      ).rejects.toThrow(`Operation ${operation._id} kept moving; try again`)

      expect(changeOf).toHaveBeenCalledTimes(3)
      expect((await findOperation(db, operation._id)).state).toBe('requested')
    })

    test('tries four times by default', async () => {
      const operation = await seedOperation()
      const changeOf = vi.fn(() => ({ state: 'committed' }))

      await expect(
        writeWithRetry(ctx({ db: racingDb(10) }), operation._id, changeOf)
      ).rejects.toThrow('kept moving')

      expect(changeOf).toHaveBeenCalledTimes(4)
    })

    test('succeeds on the last attempt', async () => {
      const operation = await seedOperation()

      const written = await writeWithRetry(
        ctx({ db: racingDb(2) }),
        operation._id,
        () => ({ state: 'committed' }),
        3
      )

      expect(written.state).toBe('committed')
    })
  })
})
