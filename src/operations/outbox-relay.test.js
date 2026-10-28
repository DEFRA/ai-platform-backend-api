import { MongoClient } from 'mongodb'

import { createInMemoryCommandPublisher } from '#/adapters/in-memory-command-publisher.js'
import { OID } from '#/common/test-helpers/gitops-messages.js'
import { validateCommand } from '#/contracts/message-validators.js'
import { gitopsSettings } from '#/operations/gitops-settings.js'
import {
  buildCommand,
  buildOperation,
  newOutboxEntry,
  submissionFields
} from '#/operations/operation-factory.js'
import {
  claimOutboxEntry,
  findOperation,
  insertOperation
} from '#/operations/operation-repository.js'
import { createOutboxRelay } from '#/operations/outbox-relay.js'

const DATABASE = 'outbox-relay-test'
const FIVE_MINUTES_MS = 5 * 60 * 1000
const DOCUMENT = { environment: 'infradev', revision: 4, secretMarker: 'TOP' }
const LEASE_MS = 20

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('outbox-relay', () => {
  let client
  let db
  let clock
  let publisher
  let logger
  let teams

  // An operation whose outbox holds one unpublished entry per type given.
  async function seedOperation(types = ['submit'], overrides = {}) {
    teams += 1

    const entries = types.map((type) =>
      newOutboxEntry(type, { attempt: 1 }, { state: 'deploying' })
    )
    const operation = {
      ...buildOperation({
        type: 'team-file.write',
        state: 'requested',
        teamId: `team-${teams}`,
        environment: 'infradev',
        target: {
          repository: 'DEFRA/ai-platform-tenants',
          team: 'alpha',
          path: 'environments/infradev/alpha.json'
        },
        items: [],
        slot: 'active',
        requestedBy: `entra:${OID}`
      }),
      ...submissionFields({ document: DOCUMENT, expectedRevision: 3 }),
      outbox: entries,
      outboxPending: true,
      ...overrides
    }

    await insertOperation(db, operation)

    return operation
  }

  function relayWith(overrides = {}) {
    return createOutboxRelay({
      db,
      publisher,
      settings: gitopsSettings({ outboxLeaseMs: LEASE_MS }),
      logger,
      ...overrides
    })
  }

  // A database whose first mark of an entry as published fails, as an
  // instance that crashed between publishing and marking would.
  function crashOnMark() {
    return {
      collection(name) {
        const collection = db.collection(name)

        if (name === 'operations') {
          const original = collection.updateOne.bind(collection)

          collection.updateOne = (filter, ...rest) =>
            'outbox.commandId' in filter
              ? Promise.reject(new Error('instance crashed'))
              : original(filter, ...rest)
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
    teams = 0
    clock = 1_000_000
    publisher = createInMemoryCommandPublisher({ now: () => clock })
    logger = { warn: vi.fn() }
  })

  describe('publishOperation', () => {
    test('publishes each unpublished entry as a valid command and marks it published', async () => {
      const operation = await seedOperation(['submit', 'apply'])

      const count = await relayWith().publishOperation(operation._id)
      const stored = await findOperation(db, operation._id)

      expect(count).toBe(2)
      expect(publisher.published).toHaveLength(2)
      expect(
        publisher.published.map((command) => validateCommand(command).valid)
      ).toEqual([true, true])
      expect(publisher.published.map(({ type }) => type)).toEqual([
        'submit',
        'apply'
      ])
      expect(publisher.published.map(({ commandId }) => commandId)).toEqual(
        operation.outbox.map(({ commandId }) => commandId)
      )
      expect(publisher.published[0]).toMatchObject({
        operationId: operation._id,
        action: 'write',
        document: operation.document,
        expectedRevision: 3
      })
      expect(
        stored.outbox.map(({ publishedAt }) => typeof publishedAt)
      ).toEqual(['string', 'string'])
      expect(stored.outbox.map(({ claimedUntil }) => claimedUntil)).toEqual([
        null,
        null
      ])
      expect(stored.outboxPending).toBe(false)
    })

    test('builds the command from the operation as it is when published', async () => {
      const operation = await seedOperation(['submit'])

      await db
        .collection('operations')
        .updateOne({ _id: operation._id }, { $set: { traceparent: null } })

      await relayWith().publishOperation(operation._id)

      expect(publisher.published[0]).toEqual(
        buildCommand(
          await findOperation(db, operation._id),
          operation.outbox[0]
        )
      )
    })

    test('skips an entry that is already published', async () => {
      const operation = await seedOperation(['submit', 'apply'])

      await db.collection('operations').updateOne(
        { _id: operation._id },
        {
          $set: { 'outbox.0.publishedAt': '2026-10-26T12:00:00.000Z' }
        }
      )

      const count = await relayWith().publishOperation(operation._id)

      expect(count).toBe(1)
      expect(publisher.published.map(({ type }) => type)).toEqual(['apply'])
      expect((await findOperation(db, operation._id)).outboxPending).toBe(false)
    })

    test('publishes nothing for an operation that does not exist', async () => {
      const count = await relayWith().publishOperation('no-such-operation')

      expect(count).toBe(0)
      expect(publisher.published).toEqual([])
    })

    test('publishes nothing for an operation with no outbox', async () => {
      const operation = await seedOperation([], { outboxPending: false })

      expect(await relayWith().publishOperation(operation._id)).toBe(0)
      expect(publisher.published).toEqual([])
    })

    test('does not publish an entry another instance has claimed', async () => {
      const operation = await seedOperation(['submit'])

      await claimOutboxEntry(db, {
        operationId: operation._id,
        commandId: operation.outbox[0].commandId,
        leaseMs: 60_000
      })

      expect(await relayWith().publishOperation(operation._id)).toBe(0)
      expect(publisher.published).toEqual([])
    })

    test('needs no logger', async () => {
      const operation = await seedOperation(['submit'])

      publisher.setAvailable(false)

      await expect(
        relayWith({ logger: undefined }).publishOperation(operation._id)
      ).resolves.toBe(0)
    })
  })

  describe('when the queue is unavailable', () => {
    test('leaves the entries pending and warns with IDs only', async () => {
      const operation = await seedOperation(['submit', 'apply'])

      publisher.setAvailable(false)

      const count = await relayWith().publishOperation(operation._id)
      const stored = await findOperation(db, operation._id)

      expect(count).toBe(0)
      expect(stored.outboxPending).toBe(true)
      expect(stored.outbox.map(({ publishedAt }) => publishedAt)).toEqual([
        null,
        null
      ])
      expect(logger.warn).toHaveBeenCalledTimes(2)
      expect(logger.warn).toHaveBeenCalledWith(
        {
          operationId: operation._id,
          commandId: operation.outbox[0].commandId,
          code: 'Error'
        },
        'A command could not be published, the sweep will retry'
      )

      const logged = JSON.stringify(logger.warn.mock.calls)

      expect(logged).not.toContain(DOCUMENT.secretMarker)
      expect(logged).not.toContain('queue unavailable')
    })

    test('logs the failure code when the publisher gives one', async () => {
      const operation = await seedOperation(['submit'], {
        requestedBy: 'not-a-principal'
      })

      expect(await relayWith().publishOperation(operation._id)).toBe(0)
      expect(logger.warn.mock.calls[0][0]).toEqual({
        operationId: operation._id,
        commandId: operation.outbox[0].commandId,
        code: 'invalid-command'
      })
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
        DOCUMENT.secretMarker
      )
      expect((await findOperation(db, operation._id)).outboxPending).toBe(true)
    })

    test('publishes them on the next sweep once the claim lapses', async () => {
      const operation = await seedOperation(['submit', 'apply'])
      const relay = relayWith()

      publisher.setAvailable(false)
      await relay.publishOperation(operation._id)
      publisher.setAvailable(true)
      await sleep(LEASE_MS * 3)

      expect(await relay.sweep()).toBe(2)
      expect(publisher.published.map(({ type }) => type)).toEqual([
        'submit',
        'apply'
      ])
      expect((await findOperation(db, operation._id)).outboxPending).toBe(false)
    })

    test('does not retry before the claim lapses', async () => {
      const operation = await seedOperation(['submit'])
      const relay = relayWith({
        settings: gitopsSettings({ outboxLeaseMs: 60_000 })
      })

      publisher.setAvailable(false)
      await relay.publishOperation(operation._id)
      publisher.setAvailable(true)

      expect(await relay.sweep()).toBe(0)
      expect(publisher.published).toEqual([])
    })
  })

  describe('two relays', () => {
    test('publish each entry of an operation once between them', async () => {
      const operation = await seedOperation(['submit', 'apply', 'reconcile'])
      const first = relayWith()
      const second = relayWith()

      const counts = await Promise.all([
        first.publishOperation(operation._id),
        second.publishOperation(operation._id)
      ])

      expect(counts[0] + counts[1]).toBe(3)
      expect(
        publisher.published.map(({ commandId }) => commandId).sort()
      ).toEqual(operation.outbox.map(({ commandId }) => commandId).sort())
      expect(publisher.delivered).toHaveLength(3)
    })

    test('sweeping together publish each pending entry once', async () => {
      const a = await seedOperation(['submit'])
      const b = await seedOperation(['submit', 'apply'])
      const counts = await Promise.all([
        relayWith().sweep(),
        relayWith().sweep(),
        relayWith().sweep()
      ])

      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(3)
      expect(
        publisher.published.map(({ commandId }) => commandId).sort()
      ).toEqual(
        [...a.outbox, ...b.outbox].map(({ commandId }) => commandId).sort()
      )
    })
  })

  describe('republishing after a crash between publish and mark', () => {
    async function crashAfterPublishing(operation) {
      await expect(
        relayWith({ db: crashOnMark() }).publishOperation(operation._id)
      ).rejects.toThrow('instance crashed')
      await sleep(LEASE_MS * 3)
    }

    test('keeps the same command ID, so the queue delivers it once within five minutes', async () => {
      const operation = await seedOperation(['submit'])
      const { commandId } = operation.outbox[0]

      await crashAfterPublishing(operation)

      expect((await findOperation(db, operation._id)).outboxPending).toBe(true)

      clock += FIVE_MINUTES_MS - 1
      expect(await relayWith().sweep()).toBe(1)

      expect(publisher.published.map((command) => command.commandId)).toEqual([
        commandId,
        commandId
      ])
      expect(publisher.delivered).toHaveLength(1)
      expect((await findOperation(db, operation._id)).outboxPending).toBe(false)
    })

    test('is delivered again once five minutes have passed', async () => {
      const operation = await seedOperation(['submit'])
      const { commandId } = operation.outbox[0]

      await crashAfterPublishing(operation)

      clock += FIVE_MINUTES_MS
      expect(await relayWith().sweep()).toBe(1)

      expect(publisher.published.map((command) => command.commandId)).toEqual([
        commandId,
        commandId
      ])
      expect(publisher.delivered.map((command) => command.commandId)).toEqual([
        commandId,
        commandId
      ])
    })

    test('does not publish an entry again once it is marked', async () => {
      await seedOperation(['submit'])

      const relay = relayWith()

      await relay.sweep()
      await sleep(LEASE_MS * 3)

      expect(await relay.sweep()).toBe(0)
      expect(publisher.published).toHaveLength(1)
    })
  })

  describe('sweep', () => {
    test('returns how many entries it published across operations', async () => {
      await seedOperation(['submit'])
      await seedOperation(['submit', 'apply'])

      expect(await relayWith().sweep()).toBe(3)
      expect(publisher.published).toHaveLength(3)
    })

    test('returns 0 when nothing is pending', async () => {
      await seedOperation(['submit'], { outboxPending: false })

      expect(await relayWith().sweep()).toBe(0)
      expect(publisher.published).toEqual([])
    })

    test('counts only the entries that were published when some fail', async () => {
      await seedOperation(['submit'])
      await seedOperation(['submit'], { requestedBy: 'not-a-principal' })

      expect(await relayWith().sweep()).toBe(1)
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })

    test('publishes an entry a request path left behind', async () => {
      const operation = await seedOperation(['apply'])

      await relayWith().sweep()

      expect(publisher.published[0]).toMatchObject({
        type: 'apply',
        operationId: operation._id,
        attempt: 1
      })
      expect(publisher.published[0]).not.toHaveProperty('document')
    })
  })
})
