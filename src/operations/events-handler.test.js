import { MongoClient } from 'mongodb'

import { mockTeamFileReader } from '#/adapters/mock-team-file-reader.js'
import {
  exampleEvent,
  OID,
  SHA
} from '#/common/test-helpers/gitops-messages.js'
import { createEnvironmentControls } from '#/operations/environment-controls.js'
import { createEventsHandler } from '#/operations/events-handler.js'
import { gitopsSettings } from '#/operations/gitops-settings.js'
import { buildOperation } from '#/operations/operation-factory.js'
import {
  createOperationIndexes,
  findOperation,
  insertOperation
} from '#/operations/operation-repository.js'
import { createOperationsService } from '#/operations/operations-service.js'

const DATABASE = 'events-handler-test'
const OP_ID = 'op-7f3c9a1e'
const SUBMIT_RUN = 25000000001
const APPLY_RUN = 25000000010
const RETRY_RUN = 25000000011
const REVERT_GRACE_MS = 300000
const HELD_MS = 1800000
const RESUBMIT_MAX = 3
const DEADLINES = {
  requested: 600000,
  committed: 1800000,
  deploying: 2700000,
  deployed: 900000
}
const PAUSED_REFUSAL = {
  code: 'paused',
  message: 'The environment is paused',
  retryable: true
}
const STALE_REFUSAL = {
  code: 'stale-revision',
  message: 'The file moved on',
  retryable: true
}

function pauseEvent(status, overrides = {}) {
  return exampleEvent(status, {
    action: 'pause',
    team: null,
    path: null,
    operationId: null,
    ...overrides
  })
}

describe('events-handler', () => {
  const settings = gitopsSettings({
    environments: ['infradev'],
    deadlines: DEADLINES,
    deadlineHeldMs: HELD_MS,
    resubmitMax: RESUBMIT_MAX,
    revertGraceMs: REVERT_GRACE_MS
  })
  let client
  let db
  let logger
  let relay
  let corroborator
  let verifier
  let external
  let controls
  let service
  let handler
  let teams = 0

  async function seed(state, overrides = {}) {
    teams += 1

    return insertOperation(db, {
      ...buildOperation({
        type: 'team-file.write',
        state,
        teamId: `team-${teams}`,
        environment: 'infradev',
        target: {
          repository: 'DEFRA/ai-platform-tenants',
          team: 'alpha',
          path: 'environments/infradev/alpha.json'
        },
        items: [{ entryId: 'entry-1', modelSlug: 'gpt-4o', change: 'add' }],
        slot: 'active',
        requestedBy: `entra:${OID}`
      }),
      _id: OP_ID,
      ...overrides
    })
  }

  // A failed apply, as it stands after the handler counted it.
  function seedDeploying(overrides = {}) {
    return seed('deploying', {
      gitops: { commitSha: SHA, applyRunId: APPLY_RUN },
      ...overrides
    })
  }

  function build(database = db) {
    return createEventsHandler({
      ctx: { db: database, settings, logger },
      operations: service,
      verifier,
      corroborator,
      controls,
      external
    })
  }

  function event(status, overrides = {}) {
    return exampleEvent(status, { operationId: OP_ID, ...overrides })
  }

  function deploying(runId = APPLY_RUN, overrides = {}) {
    return event('deploying', { runId, ...overrides })
  }

  function stored(id = OP_ID) {
    return findOperation(db, id)
  }

  function setControl(control) {
    return db.collection('environmentControls').insertOne({
      _id: 'infradev',
      runId: 25000000019,
      runStartedAt: '2026-10-26T11:00:00Z',
      requestedBy: `entra:${OID}`,
      ...control
    })
  }

  function expectDueIn(deadlineAt, ms, before) {
    expect(Date.parse(deadlineAt)).toBeGreaterThanOrEqual(before + ms)
    expect(Date.parse(deadlineAt)).toBeLessThanOrEqual(Date.now() + ms)
  }

  // A database that loses the first `losses` writes to another writer; with
  // `eventId` the other writer has recorded that same event.
  function racingDb(losses, eventId) {
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
                {
                  $inc: { stateVersion: 1 },
                  ...(eventId
                    ? { $push: { history: { state: 'x', eventId } } }
                    : {})
                }
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
    await createOperationIndexes(db)
  })

  afterAll(async () => {
    await client.db(DATABASE).dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    for (const name of [
      'operations',
      'environmentControls',
      'teamDeployments',
      'auditEvents'
    ]) {
      await db.collection(name).deleteMany({})
    }

    logger = { warn: vi.fn(), error: vi.fn() }
    relay = { publishOperation: vi.fn().mockResolvedValue(1) }
    corroborator = {
      corroborateFailure: vi.fn().mockResolvedValue({
        ok: true,
        run: { runStartedAt: '2026-10-26T12:00:00Z' }
      }),
      corroboratePause: vi.fn().mockResolvedValue({
        ok: true,
        run: { runStartedAt: '2026-10-26T12:00:00Z' }
      })
    }
    verifier = { verify: vi.fn().mockResolvedValue(null) }
    external = {
      record: vi.fn().mockResolvedValue({ outcome: 'recorded' }),
      recordBreakGlass: vi.fn().mockResolvedValue({ outcome: 'recorded' })
    }
    controls = createEnvironmentControls({ db, corroborator, logger })
    service = createOperationsService({
      db,
      settings,
      relay,
      buildDocument: async () => ({
        document: { environment: 'infradev', revision: 5 },
        expectedRevision: 4
      }),
      reader: mockTeamFileReader,
      controls,
      logger
    })
    handler = build()
  })

  describe('an event that is not acted on', () => {
    test('drops one that breaks the schema, logging its ID', async () => {
      const result = await handler.handle({
        ...event('requested'),
        status: 'bogus'
      })

      expect(result).toEqual({ outcome: 'dropped', reason: 'invalid' })
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: expect.any(String) }),
        'An invalid event was dropped'
      )
    })

    test('drops a message that is not an object at all', async () => {
      expect(await handler.handle(null)).toEqual({
        outcome: 'dropped',
        reason: 'invalid'
      })
    })

    test('drops an event for an environment the portal does not run', async () => {
      await seed('requested')

      const result = await handler.handle(
        event('committed', { environment: 'sandbox' })
      )

      expect(result).toEqual({
        outcome: 'dropped',
        reason: 'unknown-environment'
      })
      expect((await stored()).state).toBe('requested')
    })

    test.each([
      ['team', { team: 'beta' }],
      ['path', { path: 'environments/infradev/beta.json' }],
      ['repository', { repository: 'DEFRA/ai-platform-deployments' }]
    ])(
      'drops an event whose %s differs from its operation',
      async (_, change) => {
        await seed('requested')

        const result = await handler.handle(event('committed', change))

        expect(result).toEqual({ outcome: 'dropped', reason: 'target-differs' })
        expect((await stored()).state).toBe('requested')
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'target-differs' }),
          'An event was dropped'
        )
      }
    )

    test('ignores a deploy-failed from a run older than the apply recorded, without corroborating it', async () => {
      await seedDeploying({ gitops: { applyRunId: APPLY_RUN + 5 } })

      const result = await handler.handle(
        event('deploy-failed', { runId: APPLY_RUN })
      )

      expect(result).toEqual({ outcome: 'ignore' })
      expect(corroborator.corroborateFailure).not.toHaveBeenCalled()
      expect((await stored()).stateVersion).toBe(0)
    })
  })

  describe('an event for no operation of the portal', () => {
    test('records a run with no operation ID as external', async () => {
      const message = exampleEvent('deploying', {
        action: 'apply',
        operationId: null,
        team: null,
        path: null
      })

      expect(await handler.handle(message)).toEqual({ outcome: 'recorded' })
      expect(external.record).toHaveBeenCalledWith(message)
    })

    test('records a run whose operation ID is unknown as external', async () => {
      const message = event('requested', { operationId: 'op-unknown' })

      await handler.handle(message)

      expect(external.record).toHaveBeenCalledWith(message)
    })

    test('records an event of an operation that is itself external', async () => {
      await seed('requested', { externalKey: 'DEFRA/ai-platform-tenants:1' })
      const message = event('committed')

      await handler.handle(message)

      expect(external.record).toHaveBeenCalledWith(message)
      expect((await stored()).state).toBe('requested')
    })

    test('hands a break-glass event to the external recorder', async () => {
      const message = exampleEvent('committed', {
        action: 'break-glass',
        team: null,
        path: null,
        operationId: null,
        source: 'reconciler',
        pullRequestUrl: 'https://github.com/DEFRA/ai-platform-tenants/pull/9'
      })

      expect(await handler.handle(message)).toEqual({ outcome: 'recorded' })
      expect(external.recordBreakGlass).toHaveBeenCalledWith(message)
      expect(external.record).not.toHaveBeenCalled()
    })
  })

  describe('a pause or resume', () => {
    test('applies a corroborated pause and holds nothing to resubmit', async () => {
      const result = await handler.handle(pauseEvent('paused'))

      expect(result).toEqual({ outcome: 'applied', paused: true })
      expect(await controls.isPaused('infradev')).toBe(true)
    })

    test('drops a pause that is not corroborated', async () => {
      corroborator.corroboratePause.mockResolvedValue({
        ok: false,
        reason: 'actor-not-admin'
      })

      const result = await handler.handle(pauseEvent('paused'))

      expect(result).toEqual({ outcome: 'uncorroborated' })
      expect(await controls.isPaused('infradev')).toBe(false)
    })

    describe('on resume', () => {
      beforeEach(() => setControl({ paused: true }))

      test('rebuilds and resubmits a held write, uncounted', async () => {
        await seed('queued', {
          held: { code: 'paused', since: '2026-10-26T11:30:00Z' },
          resubmitCount: 1
        })

        const result = await handler.handle(pauseEvent('resumed'))

        const resubmitted = await stored()

        expect(result).toEqual({ outcome: 'applied', paused: false })
        expect(resubmitted).toMatchObject({
          state: 'requested',
          resubmitCount: 1
        })
        expect(resubmitted.held).toBeUndefined()
        expect(resubmitted.outbox.map(({ type }) => type)).toEqual(['submit'])
        expect(relay.publishOperation).toHaveBeenCalledWith(OP_ID)
      })

      test('publishes the apply of a deferred retry again', async () => {
        await seedDeploying({
          deferred: 'retry',
          deferredSince: '2026-10-26T11:30:00Z'
        })

        await handler.handle(pauseEvent('resumed'))

        const rearmed = await stored()

        expect(rearmed.deferred).toBeUndefined()
        expect(rearmed.outbox.map(({ type }) => type)).toEqual(['apply'])
      })

      test('makes a deferred revert due at once for the sweeper', async () => {
        await seed('deploy-failed', {
          deferred: 'revert',
          deadlineAt: '2099-01-01T00:00:00.000Z'
        })
        const before = Date.now()

        await handler.handle(pauseEvent('resumed'))

        const rearmed = await stored()

        expect(rearmed.deferred).toBe('revert')
        expect(Date.parse(rearmed.deadlineAt)).toBeGreaterThanOrEqual(before)
        expect(Date.parse(rearmed.deadlineAt)).toBeLessThanOrEqual(Date.now())
      })

      test('leaves other environments, and operations holding nothing, alone', async () => {
        await seed('queued', {
          environment: 'sandbox',
          held: { code: 'paused', since: '2026-10-26T11:30:00Z' },
          _id: 'op-sandbox'
        })
        await seed('committed', { _id: 'op-plain' })

        await handler.handle(pauseEvent('resumed'))

        expect((await stored('op-sandbox')).state).toBe('queued')
        expect((await stored('op-plain')).stateVersion).toBe(0)
        expect(relay.publishOperation).not.toHaveBeenCalled()
      })

      test('resubmits nothing for a resume that is stale', async () => {
        await db
          .collection('environmentControls')
          .updateOne(
            { _id: 'infradev' },
            { $set: { runStartedAt: '2026-10-26T13:00:00Z' } }
          )
        await seed('queued', {
          held: { code: 'paused', since: '2026-10-26T11:30:00Z' }
        })

        const result = await handler.handle(pauseEvent('resumed'))

        expect(result).toEqual({ outcome: 'stale' })
        expect((await stored()).state).toBe('queued')
      })

      test('resubmits nothing for a resume that is not corroborated', async () => {
        corroborator.corroboratePause.mockResolvedValue({
          ok: false,
          reason: 'run-not-found'
        })
        await seed('queued', {
          held: { code: 'paused', since: '2026-10-26T11:30:00Z' }
        })

        await handler.handle(pauseEvent('resumed'))

        expect((await stored()).state).toBe('queued')
      })
    })
  })

  describe('facts only', () => {
    test('fills the submit run into a requested operation, recording no transition', async () => {
      await seed('requested')

      const result = await handler.handle(event('requested'))

      const filled = await stored()

      expect(result).toEqual({ outcome: 'fill', operationId: OP_ID })
      expect(filled.gitops).toMatchObject({
        submitRunId: SUBMIT_RUN,
        submitRunUrl: expect.stringContaining(String(SUBMIT_RUN))
      })
      expect(filled.state).toBe('requested')
      expect(filled.history).toHaveLength(1)
    })

    test('writes nothing when the operation holds the facts already', async () => {
      await seed('requested')

      await handler.handle(event('requested'))
      const again = await handler.handle(event('requested'))

      expect(again.outcome).toBe('fill')
      expect((await stored()).stateVersion).toBe(1)
    })

    test('replaces the apply run with a later one while the apply is in flight', async () => {
      await seedDeploying()

      const result = await handler.handle(deploying(RETRY_RUN))

      expect(result.outcome).toBe('replace-run')
      expect((await stored()).gitops).toMatchObject({
        applyRunId: RETRY_RUN,
        commitSha: SHA
      })
    })

    test('keeps the apply run when an earlier run reports', async () => {
      await seedDeploying()

      await handler.handle(deploying(APPLY_RUN - 1))

      expect((await stored()).gitops.applyRunId).toBe(APPLY_RUN)
    })

    test('does not corroborate or count a checks-failed for an operation past it', async () => {
      await seed('committed')

      const result = await handler.handle(event('checks-failed'))

      expect(result.outcome).toBe('fill')
      expect(corroborator.corroborateFailure).not.toHaveBeenCalled()
      expect((await stored()).state).toBe('committed')
    })
  })

  describe('an event that moves the operation forward', () => {
    test('advances to the state the event names, with its facts, event and time', async () => {
      await seed('requested')
      const message = event('committed')

      const result = await handler.handle(message)

      const advanced = await stored()

      expect(result).toEqual({ outcome: 'advance', operationId: OP_ID })
      expect(advanced.state).toBe('committed')
      expect(advanced.gitops).toMatchObject({
        commitSha: SHA,
        committedAt: '2026-10-26T12:00:24Z'
      })
      expect(advanced.history.at(-1)).toEqual({
        state: 'committed',
        at: message.timestamp,
        receivedAt: expect.any(String),
        source: 'submit',
        eventId: message.eventId
      })
      expect(advanced.deadlineAt).not.toBeNull()
    })

    test('does not corroborate an event that is not a failure', async () => {
      await seed('requested')

      await handler.handle(event('committed'))

      expect(corroborator.corroborateFailure).not.toHaveBeenCalled()
    })

    test('treats a redelivery as a duplicate and repairs its projection', async () => {
      const operation = await seed('requested')
      await db.collection('teamDeployments').insertOne({
        teamId: operation.teamId,
        environment: 'infradev',
        deployments: [{ id: 'entry-1', status: 'requested' }]
      })
      const message = event('committed')
      await handler.handle(message)
      await db.collection('teamDeployments').updateOne(
        {},
        {
          $set: {
            'deployments.0.status': 'requested',
            'deployments.0.projectedVersion': 0
          }
        }
      )

      const again = await handler.handle(message)

      const [{ deployments }] = await db
        .collection('teamDeployments')
        .find({})
        .toArray()

      expect(again).toEqual({ outcome: 'duplicate' })
      expect(deployments[0].status).toBe('committed')
      expect((await stored()).stateVersion).toBe(1)
    })

    test('verifies a deployed operation once, right after the write', async () => {
      await seedDeploying()

      const result = await handler.handle(event('deployed'))

      expect(result.outcome).toBe('advance')
      expect((await stored()).state).toBe('deployed')
      expect(verifier.verify).toHaveBeenCalledTimes(1)
      expect(verifier.verify).toHaveBeenCalledWith(OP_ID)
    })

    test('revives a timed-out operation from the state it left, clearing its error', async () => {
      await seed('timed-out', {
        leftState: 'committed',
        error: { code: 'operation-timed-out', message: 'm', retryable: false }
      })

      await handler.handle(deploying())

      const revived = await stored()

      expect(revived.state).toBe('deploying')
      expect(revived.error).toBeUndefined()
      expect(revived.leftState).toBeUndefined()
    })

    test('lets a timed-out operation take a facts-only event without reviving it', async () => {
      await seed('timed-out', { leftState: 'committed' })

      const result = await handler.handle(event('requested'))

      expect(result.outcome).toBe('fill')
      expect((await stored()).state).toBe('timed-out')
    })
  })

  describe('a permanent refusal (checks-failed)', () => {
    test('corroborates it, ends the operation checks-failed with the reason and frees the file', async () => {
      await seed('requested')
      const message = event('checks-failed')

      const result = await handler.handle(message)

      const ended = await stored()

      expect(result.outcome).toBe('advance')
      expect(corroborator.corroborateFailure).toHaveBeenCalledWith(
        message,
        expect.objectContaining({ _id: OP_ID })
      )
      expect(ended.state).toBe('checks-failed')
      expect(ended.error).toEqual({
        code: 'operation-checks-failed',
        message: 'The file failed validation',
        retryable: false
      })
      expect(ended.slot).toBeUndefined()
      expect(ended.deadlineAt).toBeNull()
    })

    test('promotes the waiting operation once the file is free', async () => {
      const active = await seed('requested')
      await seed('queued', {
        _id: 'op-waiting',
        teamId: active.teamId,
        slot: 'waiting'
      })

      await handler.handle(event('checks-failed'))

      expect(await stored('op-waiting')).toMatchObject({
        slot: 'active',
        state: 'requested'
      })
    })

    test('drops it when GitHub does not bear it out, leaving the operation as it was', async () => {
      await seed('requested')
      corroborator.corroborateFailure.mockResolvedValue({
        ok: false,
        reason: 'run-did-not-fail'
      })

      const result = await handler.handle(event('checks-failed'))

      expect(result).toEqual({ outcome: 'dropped', reason: 'run-did-not-fail' })
      expect(await stored()).toMatchObject({
        state: 'requested',
        stateVersion: 0
      })
    })

    test('throws when corroboration is transiently unavailable, so the message is redelivered', async () => {
      await seed('requested')
      corroborator.corroborateFailure.mockResolvedValue({
        ok: false,
        reason: 'report-unavailable',
        transient: true
      })

      await expect(handler.handle(event('checks-failed'))).rejects.toThrow(
        'Cannot corroborate yet: report-unavailable'
      )
      expect((await stored()).state).toBe('requested')
    })

    test('is accepted on the redelivery once corroboration works', async () => {
      await seed('requested')
      corroborator.corroborateFailure
        .mockResolvedValueOnce({ ok: false, reason: 'x', transient: true })
        .mockResolvedValueOnce({ ok: true })

      await expect(handler.handle(event('checks-failed'))).rejects.toThrow()
      const result = await handler.handle(event('checks-failed'))

      expect(result.outcome).toBe('advance')
      expect((await stored()).state).toBe('checks-failed')
    })
  })

  describe('a retryable refusal', () => {
    function refusal(failureReason = STALE_REFUSAL, overrides = {}) {
      return event('checks-failed', { failureReason, ...overrides })
    }

    test('holds the write queued and resubmits it after 10 s for the first refusal', async () => {
      await seed('requested')
      const before = Date.now()

      const result = await handler.handle(refusal())

      const held = await stored()

      expect(result.outcome).toBe('hold')
      expect(held.state).toBe('queued')
      expect(held.held).toEqual({
        code: 'stale-revision',
        since: expect.any(String)
      })
      expect(held.gitops.submitRunId).toBe(SUBMIT_RUN)
      expect(held.history.at(-1)).toMatchObject({
        state: 'queued',
        source: 'submit'
      })
      expectDueIn(held.deadlineAt, 10000, before)
      expect(held.slot).toBe('active')
      expect(relay.publishOperation).not.toHaveBeenCalled()
    })

    test.each([
      [0, 10000],
      [1, 30000],
      [2, 90000]
    ])(
      'waits for the resubmission after %i earlier at %i ms',
      async (used, delay) => {
        await seed('requested', { resubmitCount: used })
        const before = Date.now()

        await handler.handle(
          refusal({ ...STALE_REFUSAL, code: 'commit-conflict' })
        )

        const held = await stored()

        expect(held.held.code).toBe('commit-conflict')
        expectDueIn(held.deadlineAt, delay, before)
      }
    )

    test('ends timed-out once the resubmissions are used up, alerting an engineer', async () => {
      await seed('requested', { resubmitCount: RESUBMIT_MAX })

      const result = await handler.handle(refusal())

      const ended = await stored()

      expect(result.outcome).toBe('hold')
      expect(ended).toMatchObject({
        state: 'timed-out',
        leftState: 'requested',
        deadlineAt: null,
        error: {
          code: 'operation-timed-out',
          message: 'The file moved on',
          retryable: false
        }
      })
      expect(ended.held).toBeUndefined()
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: OP_ID, alert: true }),
        'A write was refused again and again; it needs a platform engineer'
      )
    })

    test('holds a paused refusal for the held deadline, not the resubmit delays, however many resubmissions were made', async () => {
      await seed('requested', { resubmitCount: RESUBMIT_MAX })
      await setControl({ paused: true })
      const before = Date.now()

      await handler.handle(refusal(PAUSED_REFUSAL))

      const held = await stored()

      expect(held.state).toBe('queued')
      expect(held.held.code).toBe('paused')
      expectDueIn(held.deadlineAt, HELD_MS, before)
    })

    test('doubles the deadline of a paused refusal with the passes already made', async () => {
      await seed('requested', { heldPasses: 2 })
      await setControl({ paused: true })
      const before = Date.now()

      await handler.handle(refusal(PAUSED_REFUSAL))

      expectDueIn((await stored()).deadlineAt, HELD_MS * 4, before)
    })

    test('holds a paused refusal when the environment has never been paused', async () => {
      await seed('requested')

      await handler.handle(refusal(PAUSED_REFUSAL))

      expect((await stored()).state).toBe('queued')
      expect(relay.publishOperation).not.toHaveBeenCalled()
    })

    test('resubmits at once a paused refusal from a run that started before the latest resume', async () => {
      await seed('requested')
      await setControl({
        paused: false,
        runStartedAt: '2026-10-26T12:30:00Z'
      })

      await handler.handle(refusal(PAUSED_REFUSAL))

      const resubmitted = await stored()

      expect(resubmitted.state).toBe('requested')
      expect(resubmitted.held).toBeUndefined()
      expect(resubmitted.resubmitCount).toBe(0)
      expect(resubmitted.outbox.map(({ type }) => type)).toEqual(['submit'])
      expect(relay.publishOperation).toHaveBeenCalledWith(OP_ID)
    })

    test('uses the event time when the corroborated run has no start time', async () => {
      await seed('requested')
      await setControl({
        paused: false,
        runStartedAt: '2026-10-26T12:30:00Z'
      })
      corroborator.corroborateFailure.mockResolvedValue({ ok: true })

      await handler.handle(refusal(PAUSED_REFUSAL))

      expect((await stored()).state).toBe('requested')
    })

    test('keeps holding a paused refusal from a run that started after the resume', async () => {
      await seed('requested')
      await setControl({
        paused: false,
        runStartedAt: '2026-10-26T11:30:00Z'
      })

      await handler.handle(refusal(PAUSED_REFUSAL))

      expect((await stored()).state).toBe('queued')
    })

    test('keeps holding a paused refusal while the environment is paused again', async () => {
      await seed('requested')
      await setControl({ paused: true, runStartedAt: '2026-10-26T12:30:00Z' })

      await handler.handle(refusal(PAUSED_REFUSAL))

      expect((await stored()).state).toBe('queued')
    })

    test('does not resubmit a refusal that is not about the pause at once', async () => {
      await seed('requested')
      await setControl({ paused: false, runStartedAt: '2026-10-26T12:30:00Z' })

      await handler.handle(refusal(STALE_REFUSAL))

      expect((await stored()).state).toBe('queued')
    })

    test('rejects a refusal that is not on the retryable list at the schema', async () => {
      await seed('requested')

      const result = await handler.handle(
        refusal({ code: 'stale-revision', message: 'm', retryable: false })
      )

      expect(result).toEqual({ outcome: 'dropped', reason: 'invalid' })
      expect((await stored()).state).toBe('requested')
    })
  })

  describe('a failed apply (deploy-failed)', () => {
    function failed(runId = APPLY_RUN, overrides = {}) {
      return event('deploy-failed', { runId, ...overrides })
    }

    test('counts an attributable failure, then publishes one fresh apply at attempt 2', async () => {
      await seedDeploying()

      const result = await handler.handle(failed())

      const retrying = await stored()

      expect(result.outcome).toBe('advance')
      expect(corroborator.corroborateFailure).toHaveBeenCalledTimes(1)
      expect(retrying).toMatchObject({
        state: 'deploy-failed',
        attempt: 2,
        retrying: true,
        error: {
          code: 'operation-deploy-failed',
          message: 'The apply failed',
          retryable: false
        },
        lastFailure: { runId: APPLY_RUN, runAttempt: 1 }
      })
      expect(retrying.outbox).toEqual([
        expect.objectContaining({ type: 'apply', attempt: 2 })
      ])
      expect(relay.publishOperation).toHaveBeenCalledWith(OP_ID)
      expect(retrying.slot).toBe('active')
    })

    test('defers the retry while the environment is paused', async () => {
      await seedDeploying()
      await setControl({ paused: true })
      const before = Date.now()

      await handler.handle(failed())

      const deferred = await stored()

      expect(deferred).toMatchObject({
        state: 'deploy-failed',
        attempt: 1,
        deferred: 'retry',
        retrying: true
      })
      expect(deferred.outbox).toEqual([])
      expectDueIn(deferred.deadlineAt, HELD_MS, before)
    })

    test('defers the revert after the retry failed too, for the revert grace', async () => {
      await seedDeploying()
      await handler.handle(failed())
      await handler.handle(deploying(RETRY_RUN))
      const before = Date.now()

      const result = await handler.handle(failed(RETRY_RUN))

      const second = await stored()

      expect(result.outcome).toBe('advance')
      expect(second).toMatchObject({
        state: 'deploy-failed',
        attempt: 2,
        deferred: 'revert',
        lastFailure: { runId: RETRY_RUN, runAttempt: 1 }
      })
      expect(second.outbox).toHaveLength(1)
      expectDueIn(second.deadlineAt, REVERT_GRACE_MS, before)
      expect(second.history.map(({ state }) => state)).toEqual([
        'deploying',
        'deploy-failed',
        'deploy-failed'
      ])
    })

    test('does not count the same failed run twice when it is redelivered', async () => {
      await seedDeploying()
      await handler.handle(failed())

      const again = await handler.handle(failed())

      expect(again).toEqual({ outcome: 'duplicate' })
      expect((await stored()).attempt).toBe(2)
      expect((await stored()).outbox).toHaveLength(1)
    })

    test('alerts an engineer and frees the file for a failure that is not attributable', async () => {
      await seedDeploying()

      await handler.handle(failed(APPLY_RUN, { attributable: false }))

      const ended = await stored()

      expect(ended.state).toBe('deploy-failed')
      expect(ended.attempt).toBe(1)
      expect(ended.outbox).toEqual([])
      expect(ended.slot).toBeUndefined()
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: OP_ID, alert: true }),
        'Unattributed tenants apply failure needs a platform engineer'
      )
    })

    test('defers a retryable failure (the apply was paused) without counting it', async () => {
      await seedDeploying()
      const before = Date.now()

      const result = await handler.handle(
        failed(APPLY_RUN, { failureReason: PAUSED_REFUSAL })
      )

      const deferred = await stored()

      expect(result.outcome).toBe('defer')
      expect(deferred.state).toBe('deploying')
      expect(deferred.deferred).toBe('retry')
      expect(deferred.deferredSince).toEqual(expect.any(String))
      expect(deferred.history.at(-1)).toMatchObject({
        state: 'deploying',
        eventId: expect.stringContaining('deploy-failed')
      })
      expect(deferred.attempt).toBe(1)
      expectDueIn(deferred.deadlineAt, HELD_MS, before)
      expect(relay.publishOperation).not.toHaveBeenCalled()
    })

    test('keeps when a retryable failure was first deferred', async () => {
      await seedDeploying({
        deferredSince: '2026-10-26T11:00:00.000Z',
        heldPasses: 1
      })
      const before = Date.now()

      await handler.handle(failed(APPLY_RUN, { failureReason: PAUSED_REFUSAL }))

      const deferred = await stored()

      expect(deferred.deferredSince).toBe('2026-10-26T11:00:00.000Z')
      expectDueIn(deferred.deadlineAt, HELD_MS * 2, before)
    })

    test('drops a failure that GitHub does not bear out', async () => {
      await seedDeploying()
      corroborator.corroborateFailure.mockResolvedValue({
        ok: false,
        reason: 'failing-teams-differ'
      })

      const result = await handler.handle(failed())

      expect(result).toEqual({
        outcome: 'dropped',
        reason: 'failing-teams-differ'
      })
      expect((await stored()).state).toBe('deploying')
    })

    test('throws for a failure it cannot corroborate yet, and counts nothing', async () => {
      await seedDeploying()
      corroborator.corroborateFailure.mockResolvedValue({
        ok: false,
        reason: 'report-unavailable',
        transient: true
      })

      await expect(handler.handle(failed())).rejects.toThrow(
        'Cannot corroborate yet: report-unavailable'
      )
      expect((await stored()).stateVersion).toBe(0)
    })

    test('fails the apply of a revert for good: alerts and ends the revert, leaving the file with the parent', async () => {
      const parent = await seed('deploy-failed', {
        _id: 'op-parent',
        attempt: 2,
        deferred: 'revert',
        gitops: { applyRunId: APPLY_RUN },
        lastFailure: { runId: APPLY_RUN, runAttempt: 1 }
      })

      await service.startRevert(parent)

      const { _id: childId } = await db
        .collection('operations')
        .findOne({ parentId: parent._id })

      await handler.handle(
        event('deploy-failed', { operationId: childId, runId: RETRY_RUN })
      )

      expect(await stored(childId)).toMatchObject({
        state: 'deploy-failed'
      })
      expect((await stored(childId)).slot).toBeUndefined()
      expect(await stored(parent._id)).toMatchObject({
        revertFailed: true,
        slot: 'active'
      })
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: childId, alert: true }),
        'A revert failed to apply and needs a platform engineer'
      )
    })
  })

  describe('a deployed event after a failure', () => {
    test('replaces deploy-failed, clearing the failure and verifying', async () => {
      await seed('deploy-failed', {
        gitops: { commitSha: SHA, applyRunId: APPLY_RUN },
        attempt: 2,
        retrying: true,
        error: {
          code: 'operation-deploy-failed',
          message: 'm',
          retryable: false
        },
        lastFailure: { runId: APPLY_RUN, runAttempt: 1 }
      })

      const result = await handler.handle(
        event('deployed', { runId: RETRY_RUN })
      )

      const recovered = await stored()

      expect(result.outcome).toBe('advance')
      expect(recovered.state).toBe('deployed')
      expect(recovered.error).toBeUndefined()
      expect(recovered.retrying).toBeUndefined()
      expect(recovered.lastFailure).toBeUndefined()
      expect(verifier.verify).toHaveBeenCalledWith(OP_ID)
      expect(logger.error).not.toHaveBeenCalled()
    })

    test('alerts when the apply recovered after its revert was committed', async () => {
      await seed('deploy-failed', {
        gitops: { commitSha: SHA, applyRunId: APPLY_RUN },
        revertId: 'op-revert'
      })

      await handler.handle(event('deployed', { runId: RETRY_RUN }))

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: OP_ID, alert: true }),
        'The apply recovered after its revert was committed; an engineer should check the file'
      )
      expect(verifier.verify).toHaveBeenCalledWith(OP_ID)
    })

    test('ignores a deployed from a run older than the failed apply', async () => {
      await seed('deploy-failed', {
        gitops: { commitSha: SHA, applyRunId: APPLY_RUN + 5 }
      })

      const result = await handler.handle(
        event('deployed', { runId: APPLY_RUN })
      )

      expect(result.outcome).toBe('ignore')
      expect((await stored()).state).toBe('deploy-failed')
      expect(verifier.verify).not.toHaveBeenCalled()
    })
  })

  describe('a write that races another writer', () => {
    test('reads the operation again and applies the event on top of the winner', async () => {
      await seed('requested')
      const racing = build(racingDb(1))

      const result = await racing.handle(event('committed'))

      const advanced = await stored()

      expect(result.outcome).toBe('advance')
      expect(advanced.state).toBe('committed')
      expect(advanced.stateVersion).toBe(2)
    })

    test('corroborates a failure only once however often it retries', async () => {
      await seed('requested')
      const racing = build(racingDb(2))

      await racing.handle(event('checks-failed'))

      expect(corroborator.corroborateFailure).toHaveBeenCalledTimes(1)
      expect((await stored()).state).toBe('checks-failed')
    })

    test('finds the event already recorded by the winner and reports a duplicate', async () => {
      await seed('requested')
      const message = event('committed')
      const racing = build(racingDb(1, message.eventId))

      expect(await racing.handle(message)).toEqual({ outcome: 'duplicate' })
    })

    test('throws, so the message is redelivered, when the operation keeps moving', async () => {
      await seed('requested')
      const racing = build(racingDb(99))

      await expect(racing.handle(event('committed'))).rejects.toThrow(
        `Operation ${OP_ID} kept moving`
      )
    })
  })

  describe('without a logger', () => {
    test('drops events without failing', async () => {
      const quiet = createEventsHandler({
        ctx: { db, settings },
        operations: service,
        verifier,
        corroborator,
        controls,
        external
      })

      expect(await quiet.handle({})).toEqual({
        outcome: 'dropped',
        reason: 'invalid'
      })
      expect(
        await quiet.handle(event('committed', { environment: 'sandbox' }))
      ).toEqual({ outcome: 'dropped', reason: 'unknown-environment' })
    })

    test('runs the failure paths without failing', async () => {
      await seedDeploying()
      const quiet = createEventsHandler({
        ctx: { db, settings },
        operations: service,
        verifier,
        corroborator,
        controls,
        external
      })

      await quiet.handle(event('deploy-failed', { attributable: false }))
      await quiet.handle(event('deployed', { runId: RETRY_RUN }))

      expect((await stored()).state).toBe('deployed')
    })
  })
})
