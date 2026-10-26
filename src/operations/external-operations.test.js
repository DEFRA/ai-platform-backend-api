import { MongoClient } from 'mongodb'

import {
  exampleEvent,
  OID,
  SHA
} from '#/common/test-helpers/gitops-messages.js'
import { createExternalOperations } from '#/operations/external-operations.js'
import { gitopsSettings } from '#/operations/gitops-settings.js'
import { createOperationIndexes } from '#/operations/operation-repository.js'

const DATABASE = 'external-operations-test'
const REPOSITORY = 'DEFRA/ai-platform-tenants'
const DEADLINES = {
  requested: 600000,
  committed: 1800000,
  deploying: 2700000,
  deployed: 900000
}

describe('external-operations', () => {
  let client
  let db
  let corroborator
  let logger
  let external

  function build(overrides = {}) {
    return createExternalOperations({
      db,
      corroborator,
      settings: gitopsSettings({ deadlines: DEADLINES }),
      logger,
      ...overrides
    })
  }

  function externalEvent(status, overrides = {}) {
    return exampleEvent(status, { operationId: null, ...overrides })
  }

  function operations() {
    return db.collection('operations').find({}).toArray()
  }

  function auditEvents() {
    return db.collection('auditEvents').find({}).toArray()
  }

  beforeAll(async () => {
    client = await MongoClient.connect(process.env.MONGO_URI)
    db = client.db(DATABASE)
    await createOperationIndexes(db)
  })

  afterAll(async () => {
    await client.db(DATABASE).dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    await db.collection('operations').deleteMany({})
    await db.collection('auditEvents').deleteMany({})
    logger = { warn: vi.fn() }
    corroborator = {
      corroborateRun: vi.fn().mockResolvedValue({ ok: true }),
      corroborateCommit: vi.fn().mockResolvedValue({ ok: true })
    }
    external = build()
  })

  describe('record', () => {
    test('records a run the portal did not start as one external operation of its own', async () => {
      const event = externalEvent('requested')

      const result = await external.record(event)
      const [stored] = await operations()

      expect(result.outcome).toBe('recorded')
      expect(await operations()).toHaveLength(1)
      expect(stored).toMatchObject({
        _id: result.operation._id,
        type: 'external.write',
        externalKey: `${REPOSITORY}:${event.runId}`,
        teamId: 'alpha',
        environment: 'infradev',
        target: {
          repository: REPOSITORY,
          team: 'alpha',
          path: 'environments/infradev/alpha.json'
        },
        items: [],
        requestedBy: `entra:${OID}`,
        source: 'submit',
        state: 'requested',
        stateVersion: 0,
        attempt: 1,
        reconcileCount: 0,
        gitops: {
          submitRunId: event.runId,
          submitRunUrl: event.runUrl
        },
        outbox: [],
        outboxPending: false
      })
      expect(stored.history).toEqual([
        {
          state: 'requested',
          at: event.timestamp,
          receivedAt: expect.any(String),
          source: 'submit',
          eventId: event.eventId
        }
      ])
    })

    test('holds no slot, so it never blocks the team file', async () => {
      await external.record(externalEvent('requested'))

      const [stored] = await operations()

      expect(stored).not.toHaveProperty('slot')
      expect(stored).not.toHaveProperty('idempotencyKeys')
    })

    test('carries the trace identifiers of the event', async () => {
      const event = externalEvent('requested', {
        traceparent: null,
        cdpRequestId: null
      })

      await external.record(event)

      expect((await operations())[0]).toMatchObject({
        traceparent: null,
        cdpRequestId: null
      })
    })

    test('records the type from the action of the event', async () => {
      await external.record(externalEvent('requested', { action: 'remove' }))

      expect((await operations())[0].type).toBe('external.remove')
    })

    test('records an apply with no team under its environment', async () => {
      await external.record(
        externalEvent('deploying', { action: 'apply', team: null, path: null })
      )

      expect((await operations())[0]).toMatchObject({
        type: 'external.apply',
        teamId: 'infradev',
        target: { repository: REPOSITORY, team: null, path: null },
        state: 'deploying',
        gitops: expect.objectContaining({ applyRunId: expect.any(Number) })
      })
    })

    test('corroborates the run before recording it', async () => {
      const event = externalEvent('requested')

      await external.record(event)

      expect(corroborator.corroborateRun).toHaveBeenCalledWith(event)
    })

    test('keeps one operation per repository and run', async () => {
      const event = externalEvent('requested')

      await external.record(event)
      await external.record(
        externalEvent('requested', {
          repository: 'DEFRA/ai-platform-deployments'
        })
      )
      await external.record(externalEvent('requested', { runId: 25000000002 }))

      const keys = (await operations()).map(({ externalKey }) => externalKey)

      expect(keys.sort()).toEqual(
        [
          `${REPOSITORY}:${event.runId}`,
          `DEFRA/ai-platform-deployments:${event.runId}`,
          `${REPOSITORY}:25000000002`
        ].sort()
      )
    })

    describe('an event for a run already recorded', () => {
      test('advances the operation by rank', async () => {
        const requested = externalEvent('requested')
        const committed = externalEvent('committed', {
          runId: requested.runId
        })
        const first = await external.record(requested)

        const result = await external.record(committed)
        const stored = await db
          .collection('operations')
          .findOne({ _id: first.operation._id })

        expect(result.outcome).toBe('advanced')
        expect(result.operation.state).toBe('committed')
        expect(stored).toMatchObject({
          state: 'committed',
          stateVersion: 1,
          gitops: expect.objectContaining({ commitSha: SHA })
        })
        expect(stored.history.map(({ state }) => state)).toEqual([
          'requested',
          'committed'
        ])
        expect(stored.history[1]).toMatchObject({
          source: 'submit',
          eventId: committed.eventId,
          at: committed.timestamp
        })
        expect(await operations()).toHaveLength(1)
      })

      test('does not corroborate it again', async () => {
        const requested = externalEvent('requested')

        await external.record(requested)
        await external.record(
          externalEvent('committed', { runId: requested.runId })
        )

        expect(corroborator.corroborateRun).toHaveBeenCalledTimes(1)
      })

      test('does nothing for a repeat of an event it has recorded', async () => {
        const event = externalEvent('requested')
        const first = await external.record(event)
        const before = await db
          .collection('operations')
          .findOne({ _id: first.operation._id })

        const result = await external.record(event)

        expect(result.outcome).toBe('duplicate')
        expect(
          await db.collection('operations').findOne({ _id: before._id })
        ).toEqual(before)
      })

      test('does nothing for a repeat of a later event', async () => {
        const requested = externalEvent('requested')
        const committed = externalEvent('committed', {
          runId: requested.runId
        })

        await external.record(requested)
        await external.record(committed)
        const before = (await operations())[0]

        const result = await external.record(committed)

        expect(result.outcome).toBe('duplicate')
        expect((await operations())[0]).toEqual(before)
      })

      test('moves an apply run from deploying to deploy-failed', async () => {
        const deploying = externalEvent('deploying', { action: 'apply' })

        await external.record(deploying)

        const result = await external.record(
          externalEvent('deploy-failed', {
            action: 'apply',
            runId: deploying.runId
          })
        )

        expect(result.outcome).toBe('advanced')
        expect((await operations())[0].state).toBe('deploy-failed')
      })

      test('fills a missing fact from an event of a lower rank without moving the state', async () => {
        const committed = externalEvent('committed')

        await external.record(committed)

        const result = await external.record(
          externalEvent('requested', { runId: committed.runId })
        )
        const [stored] = await operations()

        expect(result.outcome).toBe('advanced')
        expect(stored.state).toBe('committed')
        expect(stored.history).toHaveLength(1)
        expect(stored.gitops.submitRunId).toBe(committed.runId)
      })

      test('does not record another audit event', async () => {
        const requested = externalEvent('requested')

        await external.record(requested)
        await external.record(
          externalEvent('committed', { runId: requested.runId })
        )

        expect(await auditEvents()).toHaveLength(1)
      })
    })

    describe('an event the corroborator refuses', () => {
      beforeEach(() => {
        corroborator.corroborateRun.mockResolvedValue({
          ok: false,
          reason: 'not-on-main'
        })
      })

      test('is dropped, recording nothing and auditing nothing', async () => {
        const result = await external.record(externalEvent('requested'))

        expect(result).toEqual({ outcome: 'uncorroborated' })
        expect(await operations()).toEqual([])
        expect(await auditEvents()).toEqual([])
      })

      test('is logged by event ID and reason only', async () => {
        const event = externalEvent('requested')

        await external.record(event)

        expect(logger.warn).toHaveBeenCalledWith(
          { eventId: event.eventId, reason: 'not-on-main' },
          'An event for a run the portal has no operation for was not corroborated, dropped'
        )
      })

      test('needs no logger', async () => {
        await expect(
          build({ logger: undefined }).record(externalEvent('requested'))
        ).resolves.toEqual({ outcome: 'uncorroborated' })
      })
    })

    describe('when another instance records the same run first', () => {
      test('returns the existing operation and advances it, recording once', async () => {
        const requested = externalEvent('requested')
        const committed = externalEvent('committed', {
          runId: requested.runId
        })
        const other = build()

        corroborator.corroborateRun.mockImplementationOnce(async () => {
          await other.record(requested)

          return { ok: true }
        })

        const result = await external.record(committed)

        expect(result.outcome).toBe('advanced')
        expect(result.operation.state).toBe('committed')
        expect(await operations()).toHaveLength(1)
        expect(await auditEvents()).toHaveLength(1)
      })

      test('reports a duplicate when the other instance recorded the very same event', async () => {
        const event = externalEvent('requested')
        const other = build()

        corroborator.corroborateRun.mockImplementationOnce(async () => {
          await other.record(event)

          return { ok: true }
        })

        const result = await external.record(event)

        expect(result.outcome).toBe('duplicate')
        expect(await operations()).toHaveLength(1)
      })
    })

    test('propagates a failure that is not a duplicate key, recording nothing', async () => {
      const failing = {
        collection(name) {
          const collection = db.collection(name)

          return name === 'operations'
            ? {
                findOne: (...args) => collection.findOne(...args),
                insertOne: () => Promise.reject(new Error('disk is full'))
              }
            : collection
        }
      }

      await expect(
        build({ db: failing }).record(externalEvent('requested'))
      ).rejects.toThrow('disk is full')
      expect(await auditEvents()).toEqual([])
    })

    test('propagates a failure of the corroborator so the event is retried', async () => {
      corroborator.corroborateRun.mockRejectedValue(new Error('GitHub down'))

      await expect(external.record(externalEvent('requested'))).rejects.toThrow(
        'GitHub down'
      )
      expect(await operations()).toEqual([])
    })

    describe('the audit event', () => {
      test('is written once, as operation.external by the requester', async () => {
        const event = externalEvent('requested')

        const { operation } = await external.record(event)
        await external.record(event)

        const events = await auditEvents()

        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          actorUserId: event.requestedBy,
          action: 'operation.external',
          resource: 'operation',
          resourceId: operation._id,
          outcome: 'success',
          code: 'external.write',
          reason: 'submit requested'
        })
      })
    })
  })

  describe('recordBreakGlass', () => {
    function breakGlass(overrides = {}) {
      return externalEvent('committed', {
        action: 'break-glass',
        team: null,
        path: null,
        source: 'reconciler',
        pullRequestUrl: 'https://github.com/DEFRA/ai-platform-tenants/pull/9',
        ...overrides
      })
    }

    test('records an engineer commit as one break-glass operation keyed by its commit', async () => {
      const event = breakGlass()

      const result = await external.recordBreakGlass(event)
      const [stored] = await operations()

      expect(result.outcome).toBe('recorded')
      expect(stored).toMatchObject({
        type: 'break-glass',
        externalKey: `${REPOSITORY}:${SHA}`,
        teamId: 'infradev',
        environment: 'infradev',
        requestedBy: `entra:${OID}`,
        items: [],
        state: 'committed'
      })
      expect(stored).not.toHaveProperty('slot')
      expect(corroborator.corroborateCommit).toHaveBeenCalledWith(event)
      expect(corroborator.corroborateRun).not.toHaveBeenCalled()
    })

    test('audits it once as operation.external with the type break-glass', async () => {
      const { operation } = await external.recordBreakGlass(breakGlass())

      expect(await auditEvents()).toEqual([
        expect.objectContaining({
          action: 'operation.external',
          resourceId: operation._id,
          code: 'break-glass'
        })
      ])
    })

    test('records a commit once, however often it is reported', async () => {
      await external.recordBreakGlass(breakGlass())
      const again = await external.recordBreakGlass(breakGlass())
      const otherRun = await external.recordBreakGlass(
        breakGlass({ runId: 25000000099 })
      )

      expect(again.outcome).toBe('duplicate')
      expect(otherRun.outcome).toBe('advanced')
      expect(await operations()).toHaveLength(1)
      expect(await auditEvents()).toHaveLength(1)
      expect(corroborator.corroborateCommit).toHaveBeenCalledTimes(1)
    })

    test('records different commits separately', async () => {
      await external.recordBreakGlass(breakGlass())
      await external.recordBreakGlass(
        breakGlass({ commitSha: 'fedcba9876543210fedcba9876543210fedcba98' })
      )

      expect(await operations()).toHaveLength(2)
    })

    test('drops a commit that is not corroborated, and logs it', async () => {
      corroborator.corroborateCommit.mockResolvedValue({
        ok: false,
        reason: 'commit-not-on-main'
      })
      const event = breakGlass()

      const result = await external.recordBreakGlass(event)

      expect(result).toEqual({ outcome: 'uncorroborated' })
      expect(await operations()).toEqual([])
      expect(logger.warn).toHaveBeenCalledWith(
        { eventId: event.eventId, reason: 'commit-not-on-main' },
        expect.stringContaining('not corroborated')
      )
    })
  })
})
