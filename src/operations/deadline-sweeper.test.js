import { LockManager } from 'mongo-locks'
import { MongoClient } from 'mongodb'

import { mockTeamFileReader } from '#/adapters/mock-team-file-reader.js'
import { OID } from '#/common/test-helpers/gitops-messages.js'
import { createDeadlineSweeper } from '#/operations/deadline-sweeper.js'
import { createEnvironmentControls } from '#/operations/environment-controls.js'
import { gitopsSettings } from '#/operations/gitops-settings.js'
import { buildOperation } from '#/operations/operation-factory.js'
import {
  createOperationIndexes,
  findOperation,
  insertOperation
} from '#/operations/operation-repository.js'
import { overdueAction } from '#/operations/operation-state-machine.js'
import { createOperationsService } from '#/operations/operations-service.js'

// The real state machine, except that a test can make it find an operation
// not overdue after all (the clock moved between the query and the decision).
vi.mock('#/operations/operation-state-machine.js', async (importOriginal) => {
  const actual = await importOriginal()

  return { ...actual, overdueAction: vi.fn(actual.overdueAction) }
})

const DATABASE = 'deadline-sweeper-test'
const LOCK_NAME = 'gitops-deadline-sweeper'
const HELD_MS = 1800000
const RECONCILE_GRACE_MS = 600000
const RESUBMIT_MAX = 3
const HOUR_MS = 3600000
const DEADLINES = {
  requested: 600000,
  committed: 1800000,
  deploying: 2700000,
  deployed: 900000
}

function ago(ms) {
  return new Date(Date.now() - ms).toISOString()
}

describe('deadline-sweeper', () => {
  const settings = gitopsSettings({
    deadlines: DEADLINES,
    deadlineHeldMs: HELD_MS,
    heldAlarmMs: HOUR_MS,
    reconcileGraceMs: RECONCILE_GRACE_MS,
    resubmitMax: RESUBMIT_MAX
  })
  let client
  let db
  let locker
  let logger
  let relay
  let verifier
  let sweeper
  let teams = 0

  async function seed(overrides = {}) {
    teams += 1

    return insertOperation(db, {
      ...buildOperation({
        type: 'team-file.write',
        state: 'committed',
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
      deadlineAt: ago(1000),
      ...overrides
    })
  }

  function seedHeld(code, overrides = {}) {
    return seed({
      state: 'queued',
      held: { code, since: ago(1000) },
      ...overrides
    })
  }

  function pause(environment = 'infradev') {
    return db.collection('environmentControls').insertOne({
      _id: environment,
      paused: true,
      runId: 1,
      runStartedAt: ago(5000),
      requestedBy: `entra:${OID}`
    })
  }

  function build(overrides = {}) {
    const controls = createEnvironmentControls({
      db,
      corroborator: { corroboratePause: vi.fn() }
    })
    const service = createOperationsService({
      db,
      settings,
      relay,
      buildDocument: async () => ({
        document: { environment: 'infradev', revision: 2 },
        expectedRevision: 1
      }),
      reader: mockTeamFileReader,
      controls,
      logger
    })

    return createDeadlineSweeper({
      ctx: { db, settings, logger },
      locker,
      operations: service,
      verifier,
      controls,
      ...overrides
    })
  }

  function entryTypes(operation) {
    return operation.outbox.map(({ type }) => type)
  }

  beforeAll(async () => {
    client = await MongoClient.connect(process.env.MONGO_URI)
    db = client.db(DATABASE)
    locker = new LockManager(db.collection('mongo-locks'))
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
      'auditEvents',
      'mongo-locks'
    ]) {
      await db.collection(name).deleteMany({})
    }

    logger = { warn: vi.fn(), error: vi.fn() }
    relay = { publishOperation: vi.fn().mockResolvedValue(1) }
    verifier = { verify: vi.fn().mockResolvedValue(null) }
    sweeper = build()
  })

  describe('the lock', () => {
    test('returns null and touches nothing while another instance holds the lock', async () => {
      const operation = await seed()
      const lock = await locker.lock(LOCK_NAME)

      expect(await sweeper.sweep()).toBeNull()

      await lock.free()
      expect(await findOperation(db, operation._id)).toMatchObject({
        stateVersion: 0,
        reconcileCount: 0
      })
      expect(relay.publishOperation).not.toHaveBeenCalled()
    })

    test('frees the lock after a sweep so the next one runs', async () => {
      expect(await sweeper.sweep()).toEqual({
        overdue: 0,
        verified: 0,
        alarms: 0
      })
      expect(await sweeper.sweep()).not.toBeNull()
    })

    test('frees the lock when the sweep fails', async () => {
      await seed({ state: 'deployed', verify: { attempts: 1, nextAt: ago(1) } })
      verifier.verify.mockRejectedValueOnce(new Error('arm down'))

      await expect(sweeper.sweep()).rejects.toThrow('arm down')

      expect(await sweeper.sweep()).not.toBeNull()
    })
  })

  describe('an operation past its deadline', () => {
    test('finishes a verified operation by verifying it again, not by reconciling or timing it out', async () => {
      const operation = await seed({ state: 'verified', reconcileCount: 1 })

      await sweeper.sweep()

      const swept = await findOperation(db, operation._id)

      expect(verifier.verify).toHaveBeenCalledWith(operation._id)
      expect(swept.state).toBe('verified')
      expect(swept.outbox).toEqual([])
      expect(relay.publishOperation).not.toHaveBeenCalled()
    })

    test('is reconciled first: a reconcile command is published and the deadline moves 10 minutes on', async () => {
      const operation = await seed()
      const before = Date.now()

      const totals = await sweeper.sweep()

      const swept = await findOperation(db, operation._id)

      expect(totals.overdue).toBe(1)
      expect(swept.state).toBe('committed')
      expect(swept.reconcileCount).toBe(1)
      expect(Date.parse(swept.deadlineAt)).toBeGreaterThanOrEqual(
        before + RECONCILE_GRACE_MS
      )
      expect(Date.parse(swept.deadlineAt)).toBeLessThanOrEqual(
        Date.now() + RECONCILE_GRACE_MS
      )
      expect(swept.outbox).toEqual([
        expect.objectContaining({ type: 'reconcile', state: 'committed' })
      ])
      expect(relay.publishOperation).toHaveBeenCalledWith(operation._id)
    })

    test('times out on the second pass with no progress, keeping the state it left', async () => {
      const operation = await seed({ reconcileCount: 1 })

      await sweeper.sweep()

      const swept = await findOperation(db, operation._id)

      expect(swept).toMatchObject({
        state: 'timed-out',
        leftState: 'committed',
        deadlineAt: null,
        error: {
          code: 'operation-timed-out',
          message: 'No progress after a reconcile',
          retryable: false
        }
      })
      expect(swept.history.at(-1)).toMatchObject({
        state: 'timed-out',
        source: 'backend'
      })
      expect(swept.slot).toBe('active')
      expect(relay.publishOperation).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: operation._id,
          leftState: 'committed',
          code: 'operation-timed-out',
          alert: true
        }),
        'An operation timed out and needs a platform engineer'
      )
    })

    test('goes through reconcile then timed-out across two sweeps', async () => {
      const operation = await seed()

      await sweeper.sweep()
      await db
        .collection('operations')
        .updateOne({ _id: operation._id }, { $set: { deadlineAt: ago(1) } })
      await sweeper.sweep()

      expect((await findOperation(db, operation._id)).state).toBe('timed-out')
    })

    test('drops a stale held marker when it times out', async () => {
      const operation = await seed({
        reconcileCount: 1,
        held: { code: 'paused', since: ago(1000) }
      })

      await sweeper.sweep()

      const swept = await findOperation(db, operation._id)

      expect(swept.state).toBe('timed-out')
      expect(swept.held).toBeUndefined()
    })

    test('times out an operation with no logger without failing', async () => {
      const operation = await seed({ reconcileCount: 1 })
      const quiet = createDeadlineSweeper({
        ctx: { db, settings },
        locker,
        operations: { reconcile: vi.fn() },
        verifier,
        controls: { isPaused: vi.fn() }
      })

      await quiet.sweep()

      expect((await findOperation(db, operation._id)).state).toBe('timed-out')
    })

    test('does nothing when the state machine finds it not overdue after all', async () => {
      const operation = await seed()

      overdueAction.mockReturnValueOnce('wait')

      expect((await sweeper.sweep()).overdue).toBe(1)
      expect((await findOperation(db, operation._id)).stateVersion).toBe(0)
      expect(relay.publishOperation).not.toHaveBeenCalled()
    })

    test('does not alarm or log a timeout it lost to another writer', async () => {
      const operation = await seed({ reconcileCount: 1 })
      const racing = {
        collection(name) {
          const collection = db.collection(name)

          if (name === 'operations') {
            const original = collection.findOneAndUpdate.bind(collection)

            collection.findOneAndUpdate = async (filter, ...rest) => {
              await collection.updateOne(
                { _id: filter._id },
                { $inc: { stateVersion: 1 } }
              )

              return original(filter, ...rest)
            }
          }

          return collection
        }
      }
      const losing = createDeadlineSweeper({
        ctx: { db: racing, settings, logger },
        locker,
        operations: {},
        verifier,
        controls: { isPaused: vi.fn() }
      })

      await losing.sweep()

      expect((await findOperation(db, operation._id)).state).toBe('committed')
      expect(logger.error).not.toHaveBeenCalled()
    })

    test('leaves an operation whose deadline is still ahead, and one that holds no slot', async () => {
      const waiting = await seed({ deadlineAt: ago(-60000) })
      const ended = await seed({ state: 'active' })

      await db
        .collection('operations')
        .updateOne({ _id: ended._id }, { $unset: { slot: '' } })

      expect(await sweeper.sweep()).toEqual({
        overdue: 0,
        verified: 0,
        alarms: 0
      })
      expect((await findOperation(db, waiting._id)).stateVersion).toBe(0)
      expect((await findOperation(db, ended._id)).stateVersion).toBe(0)
    })

    test('counts every overdue operation, oldest first', async () => {
      const older = await seed({ deadlineAt: ago(60000) })
      const newer = await seed({ deadlineAt: ago(1000) })

      const totals = await sweeper.sweep()

      expect(totals.overdue).toBe(2)
      expect(relay.publishOperation.mock.calls.map(([id]) => id)).toEqual([
        older._id,
        newer._id
      ])
    })
  })

  describe('a held write at its deadline', () => {
    test('is rebuilt and resubmitted, counted, after a refusal', async () => {
      const operation = await seedHeld('commit-conflict', { resubmitCount: 1 })

      await sweeper.sweep()

      const swept = await findOperation(db, operation._id)

      expect(swept).toMatchObject({
        state: 'requested',
        resubmitCount: 2,
        expectedRevision: 1
      })
      expect(swept.held).toBeUndefined()
      expect(entryTypes(swept)).toEqual(['submit'])
      expect(relay.publishOperation).toHaveBeenCalledWith(operation._id)
    })

    test('counts a first resubmission from none', async () => {
      const operation = await seedHeld('stale-revision')

      await sweeper.sweep()

      expect((await findOperation(db, operation._id)).resubmitCount).toBe(1)
    })

    test('times out once the resubmissions are used up, keeping requested as the state it left', async () => {
      const operation = await seedHeld('stale-revision', {
        resubmitCount: RESUBMIT_MAX
      })

      await sweeper.sweep()

      const swept = await findOperation(db, operation._id)

      expect(swept).toMatchObject({
        state: 'timed-out',
        leftState: 'requested',
        deadlineAt: null
      })
      expect(swept.held).toBeUndefined()
      expect(relay.publishOperation).not.toHaveBeenCalled()
    })

    test('resubmits a paused write, uncounted, when the environment is no longer paused', async () => {
      const operation = await seedHeld('paused', { resubmitCount: 1 })

      await sweeper.sweep()

      const swept = await findOperation(db, operation._id)

      expect(swept).toMatchObject({ state: 'requested', resubmitCount: 1 })
      expect(entryTypes(swept)).toEqual(['submit'])
    })

    test('does not time out a paused write however many times it was resubmitted', async () => {
      const operation = await seedHeld('paused', { resubmitCount: 9 })

      await sweeper.sweep()

      expect((await findOperation(db, operation._id)).state).toBe('requested')
    })

    test('ignores a pause of another environment', async () => {
      await pause('sandbox')
      const operation = await seedHeld('paused')

      await sweeper.sweep()

      expect((await findOperation(db, operation._id)).state).toBe('requested')
    })

    test('resubmits a paused write even while the cached flag says paused, so a lost resume cannot hold it for ever', async () => {
      await pause()
      const since = ago(5000)
      const operation = await seedHeld('paused', {
        held: { code: 'paused', since },
        heldPasses: 2
      })

      await sweeper.sweep()

      const swept = await findOperation(db, operation._id)

      expect(swept).toMatchObject({
        state: 'requested',
        heldPasses: 3,
        heldSince: since
      })
      expect(swept.held).toBeUndefined()
      expect(entryTypes(swept)).toEqual(['submit'])
      expect(relay.publishOperation).toHaveBeenCalledWith(operation._id)
    })

    test('keeps the first hold time through the passes, so the alarm still counts from it', async () => {
      await pause()
      const since = ago(2 * HOUR_MS)
      const operation = await seedHeld('paused', {
        held: { code: 'paused', since },
        heldSince: ago(3 * HOUR_MS)
      })

      await sweeper.sweep()

      expect((await findOperation(db, operation._id)).heldSince).toBe(
        operation.heldSince
      )
    })
  })

  describe('deferred work at its deadline', () => {
    test('starts the revert of a failed apply that is deferred to revert', async () => {
      const parent = await seed({
        state: 'deploy-failed',
        attempt: 2,
        deferred: 'revert',
        gitops: { applyRunId: 7 },
        lastFailure: { runId: 7, runAttempt: 1 }
      })

      await sweeper.sweep()

      const swept = await findOperation(db, parent._id)
      const child = await db
        .collection('operations')
        .findOne({ parentId: parent._id })

      expect(child).toMatchObject({ type: 'team-file.revert', slot: 'revert' })
      expect(swept.revertId).toBe(child._id)
      expect(swept.deferred).toBeUndefined()
      expect(swept.deadlineAt).toBeNull()
    })

    test('publishes a fresh apply for a deferred retry when the environment is not paused', async () => {
      const operation = await seed({
        state: 'deploying',
        deferred: 'retry',
        deferredSince: ago(1000)
      })

      await sweeper.sweep()

      const swept = await findOperation(db, operation._id)

      expect(swept.deferred).toBeUndefined()
      expect(swept.retrying).toBe(true)
      expect(entryTypes(swept)).toEqual(['apply'])
      expect(relay.publishOperation).toHaveBeenCalledWith(operation._id)
    })

    test('counts the first pass of a paused deferred retry from none', async () => {
      await pause()
      const operation = await seed({ state: 'deploying', deferred: 'retry' })

      await sweeper.sweep()

      expect((await findOperation(db, operation._id)).heldPasses).toBe(1)
    })

    test('publishes the apply of a deferred retry even while the cached flag says paused, so a lost resume cannot defer it for ever', async () => {
      await pause()
      const operation = await seed({
        state: 'deploying',
        deferred: 'retry',
        heldPasses: 1
      })

      await sweeper.sweep()

      const swept = await findOperation(db, operation._id)

      expect(swept).toMatchObject({ heldPasses: 2, retrying: true })
      expect(swept.deferred).toBeUndefined()
      expect(entryTypes(swept)).toEqual(['apply'])
      expect(relay.publishOperation).toHaveBeenCalledWith(operation._id)
    })

    test('publishes the deferred retry at the attempt it was deferred for, not the current one', async () => {
      const operation = await seed({
        state: 'deploy-failed',
        attempt: 1,
        deferred: 'retry',
        deferredAttempt: 2
      })

      await sweeper.sweep()

      const swept = await findOperation(db, operation._id)

      expect(swept.attempt).toBe(2)
      expect(swept.deferredAttempt).toBeUndefined()
      expect(swept.outbox).toEqual([
        expect.objectContaining({ type: 'apply', attempt: 2 })
      ])
    })
  })

  describe('verification retries', () => {
    test('verifies a deployed operation whose verify.nextAt has passed', async () => {
      const due = await seed({
        state: 'deployed',
        deadlineAt: ago(-60000),
        verify: { attempts: 1, nextAt: ago(1000) }
      })

      const totals = await sweeper.sweep()

      expect(totals.verified).toBe(1)
      expect(verifier.verify).toHaveBeenCalledWith(due._id)
    })

    test('leaves one that is not due yet, or not deployed, or has no nextAt', async () => {
      await seed({
        state: 'deployed',
        deadlineAt: ago(-60000),
        verify: { attempts: 1, nextAt: ago(-60000) }
      })
      await seed({
        state: 'deploying',
        deadlineAt: ago(-60000),
        verify: { attempts: 1, nextAt: ago(1000) }
      })
      await seed({ state: 'deployed', deadlineAt: ago(-60000) })

      const totals = await sweeper.sweep()

      expect(totals.verified).toBe(0)
      expect(verifier.verify).not.toHaveBeenCalled()
    })

    test('verifies each due operation', async () => {
      for (let count = 0; count < 3; count += 1) {
        await seed({
          state: 'deployed',
          deadlineAt: ago(-60000),
          verify: { attempts: 1, nextAt: ago(1000) }
        })
      }

      expect((await sweeper.sweep()).verified).toBe(3)
      expect(verifier.verify).toHaveBeenCalledTimes(3)
    })

    test('also reconciles a deployed operation that is overdue', async () => {
      await seed({ state: 'deployed' })

      const totals = await sweeper.sweep()

      expect(totals.overdue).toBe(1)
      expect(relay.publishOperation).toHaveBeenCalledTimes(1)
    })
  })

  describe('the alarm for work held too long', () => {
    function farFromDeadline() {
      return { deadlineAt: ago(-HOUR_MS) }
    }

    test('raises an alarm for a held operation older than the threshold', async () => {
      const operation = await seed({
        state: 'queued',
        held: { code: 'paused', since: ago(HOUR_MS + 1000) },
        ...farFromDeadline()
      })

      const totals = await sweeper.sweep()

      expect(totals.alarms).toBe(1)
      expect(logger.error).toHaveBeenCalledWith(
        {
          operationId: operation._id,
          environment: 'infradev',
          alert: true
        },
        'An operation has been held or deferred longer than the alarm threshold'
      )
    })

    test('raises an alarm for a deferred operation older than the threshold', async () => {
      await seed({
        state: 'deploying',
        deferred: 'retry',
        deferredSince: ago(HOUR_MS + 1000),
        ...farFromDeadline()
      })

      expect((await sweeper.sweep()).alarms).toBe(1)
    })

    test('stays quiet for work held for less than the threshold', async () => {
      await seed({
        state: 'queued',
        held: { code: 'paused', since: ago(60000) },
        ...farFromDeadline()
      })
      await seed({
        state: 'deploying',
        deferred: 'retry',
        deferredSince: ago(60000),
        ...farFromDeadline()
      })

      expect((await sweeper.sweep()).alarms).toBe(0)
      expect(logger.error).not.toHaveBeenCalled()
    })

    test('ignores an old hold on an operation that no longer holds a slot', async () => {
      const operation = await seed({
        state: 'timed-out',
        held: { code: 'paused', since: ago(HOUR_MS * 2) },
        ...farFromDeadline()
      })

      await db
        .collection('operations')
        .updateOne({ _id: operation._id }, { $unset: { slot: '' } })

      expect((await sweeper.sweep()).alarms).toBe(0)
    })

    test('alarms again on every sweep until the work moves', async () => {
      await seed({
        state: 'queued',
        held: { code: 'paused', since: ago(HOUR_MS * 2) },
        ...farFromDeadline()
      })

      await sweeper.sweep()
      await sweeper.sweep()

      expect(logger.error).toHaveBeenCalledTimes(2)
    })

    test('alarms without a logger', async () => {
      await seed({
        state: 'queued',
        held: { code: 'paused', since: ago(HOUR_MS * 2) },
        ...farFromDeadline()
      })
      const quiet = createDeadlineSweeper({
        ctx: { db, settings },
        locker,
        operations: {},
        verifier,
        controls: { isPaused: vi.fn() }
      })

      expect((await quiet.sweep()).alarms).toBe(1)
    })
  })
})
