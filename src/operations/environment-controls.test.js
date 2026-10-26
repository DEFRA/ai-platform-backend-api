import { MongoClient } from 'mongodb'

import { exampleEvent, OID } from '#/common/test-helpers/gitops-messages.js'
import { createEnvironmentControls } from '#/operations/environment-controls.js'

const DATABASE = 'environment-controls-test'
const T1 = '2026-10-26T12:00:00Z'
const T2 = '2026-10-26T12:05:00Z'
const T3 = '2026-10-26T12:10:00Z'

function pauseEvent(status, runId, overrides = {}) {
  return exampleEvent(status, { runId, ...overrides })
}

describe('environment-controls', () => {
  let client
  let db
  let corroborator
  let logger
  let runStartedAts
  let controls

  function newControls(overrides = {}) {
    return createEnvironmentControls({ db, corroborator, logger, ...overrides })
  }

  // The corroborator tells each run's start time, as GitHub would.
  function startedAt(runId, time) {
    runStartedAts.set(runId, time)
  }

  function stored(environment = 'infradev') {
    return db.collection('environmentControls').findOne({ _id: environment })
  }

  // A database whose controls collection is replaced by `collection`.
  function dbWith(collection) {
    return {
      collection: (name) =>
        name === 'environmentControls' ? collection : db.collection(name)
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
    await db.collection('environmentControls').deleteMany({})
    runStartedAts = new Map()
    logger = { warn: vi.fn() }
    corroborator = {
      corroboratePause: vi.fn((event) =>
        Promise.resolve({
          ok: true,
          run: { runStartedAt: runStartedAts.get(event.runId) }
        })
      )
    }
    controls = newControls()
  })

  describe('get', () => {
    test('says an environment never paused is not paused, with no run', async () => {
      expect(await controls.get('infradev')).toEqual({
        _id: 'infradev',
        paused: false
      })
    })

    test('returns the stored control', async () => {
      startedAt(100, T1)
      await controls.apply(pauseEvent('paused', 100))

      expect(await controls.get('infradev')).toEqual({
        _id: 'infradev',
        paused: true,
        runId: 100,
        runStartedAt: T1,
        requestedBy: `entra:${OID}`
      })
    })

    test('does not write when it reads', async () => {
      await controls.get('infradev')

      expect(await stored()).toBeNull()
    })
  })

  describe('isPaused', () => {
    test('is false for an environment never paused', async () => {
      expect(await controls.isPaused('infradev')).toBe(false)
    })

    test('follows paused then resumed events', async () => {
      startedAt(100, T1)
      startedAt(101, T2)

      await controls.apply(pauseEvent('paused', 100))
      expect(await controls.isPaused('infradev')).toBe(true)

      await controls.apply(pauseEvent('resumed', 101))
      expect(await controls.isPaused('infradev')).toBe(false)
    })

    test('is per environment', async () => {
      startedAt(100, T1)
      await controls.apply(pauseEvent('paused', 100))

      expect(await controls.isPaused('infraprod')).toBe(false)
    })
  })

  describe('apply', () => {
    test('applies a corroborated paused event and records who and which run', async () => {
      startedAt(100, T1)

      const result = await controls.apply(pauseEvent('paused', 100))

      expect(result).toEqual({ outcome: 'applied', paused: true })
      expect(await stored()).toEqual({
        _id: 'infradev',
        paused: true,
        runId: 100,
        runStartedAt: T1,
        requestedBy: `entra:${OID}`
      })
      expect(corroborator.corroboratePause).toHaveBeenCalledTimes(1)
    })

    test('applies a corroborated resumed event over a paused one that started earlier', async () => {
      startedAt(100, T1)
      startedAt(101, T2)

      await controls.apply(pauseEvent('paused', 100))
      const result = await controls.apply(pauseEvent('resumed', 101))

      expect(result).toEqual({ outcome: 'applied', paused: false })
      expect(await stored()).toMatchObject({
        paused: false,
        runId: 101,
        runStartedAt: T2
      })
    })

    test('orders by start time even when the later run has the lower ID', async () => {
      startedAt(900, T1)
      startedAt(100, T2)

      await controls.apply(pauseEvent('paused', 900))
      const result = await controls.apply(pauseEvent('resumed', 100))

      expect(result.outcome).toBe('applied')
      expect(await stored()).toMatchObject({ paused: false, runId: 100 })
    })

    test('lets the run ID break a tie in start time', async () => {
      startedAt(100, T1)
      startedAt(101, T1)

      await controls.apply(pauseEvent('paused', 100))
      const result = await controls.apply(pauseEvent('resumed', 101))

      expect(result).toEqual({ outcome: 'applied', paused: false })
      expect(await stored()).toMatchObject({ paused: false, runId: 101 })
    })

    test('treats a tied start time with a lower run ID as stale', async () => {
      startedAt(100, T1)
      startedAt(101, T1)

      await controls.apply(pauseEvent('resumed', 101))
      const result = await controls.apply(pauseEvent('paused', 100))

      expect(result).toEqual({ outcome: 'stale' })
      expect(await stored()).toMatchObject({ paused: false, runId: 101 })
    })

    test('treats a repeated event as stale', async () => {
      startedAt(100, T1)

      await controls.apply(pauseEvent('paused', 100))
      const before = await stored()
      const result = await controls.apply(pauseEvent('paused', 100))

      expect(result).toEqual({ outcome: 'stale' })
      expect(await stored()).toEqual(before)
    })

    test('treats an event of an older run as stale and changes nothing', async () => {
      startedAt(100, T1)
      startedAt(101, T3)

      await controls.apply(pauseEvent('paused', 101))
      const result = await controls.apply(pauseEvent('resumed', 100))

      expect(result).toEqual({ outcome: 'stale' })
      expect(await stored()).toMatchObject({
        paused: true,
        runId: 101,
        runStartedAt: T3
      })
    })

    test.each([
      ['paused then resumed', ['paused', 100, T1], ['resumed', 101, T2], false],
      ['resumed then paused', ['resumed', 100, T1], ['paused', 101, T2], true]
    ])(
      'ends as the later run wherever the events arrive: %s',
      async (name, first, second, pausedAtEnd) => {
        for (const order of [
          [first, second],
          [second, first]
        ]) {
          await db.collection('environmentControls').deleteMany({})

          for (const [, runId, time] of [first, second]) {
            startedAt(runId, time)
          }

          for (const [status, runId] of order) {
            await controls.apply(pauseEvent(status, runId))
          }

          expect((await stored()).paused).toBe(pausedAtEnd)
          expect((await stored()).runId).toBe(second[1])
        }
      }
    )

    test('does not let an out-of-order older event change the newer control', async () => {
      startedAt(100, T1)
      startedAt(101, T2)

      expect(await controls.apply(pauseEvent('resumed', 101))).toEqual({
        outcome: 'applied',
        paused: false
      })
      expect(await controls.apply(pauseEvent('paused', 100))).toEqual({
        outcome: 'stale'
      })
      expect(await controls.isPaused('infradev')).toBe(false)
    })

    test('keeps each environment apart', async () => {
      startedAt(100, T1)
      startedAt(101, T2)

      await controls.apply(pauseEvent('paused', 100))
      const result = await controls.apply(
        pauseEvent('resumed', 101, { environment: 'infraprod' })
      )

      expect(result.outcome).toBe('applied')
      expect(await controls.isPaused('infradev')).toBe(true)
    })

    describe('an event the corroborator refuses', () => {
      beforeEach(() => {
        corroborator.corroboratePause.mockResolvedValue({
          ok: false,
          reason: 'actor-not-admin'
        })
      })

      test('is dropped and logged by ID and reason only', async () => {
        const event = pauseEvent('paused', 100)

        const result = await controls.apply(event)

        expect(result).toEqual({ outcome: 'uncorroborated' })
        expect(await stored()).toBeNull()
        expect(logger.warn).toHaveBeenCalledWith(
          { eventId: event.eventId, reason: 'actor-not-admin' },
          'A pause event was not corroborated, dropped'
        )
      })

      test('does not change an existing control', async () => {
        await db.collection('environmentControls').insertOne({
          _id: 'infradev',
          paused: true,
          runId: 1,
          runStartedAt: T1,
          requestedBy: 'entra:x'
        })

        await controls.apply(pauseEvent('resumed', 100))

        expect((await stored()).paused).toBe(true)
      })

      test('needs no logger', async () => {
        const quiet = newControls({ logger: undefined })

        await expect(quiet.apply(pauseEvent('paused', 100))).resolves.toEqual({
          outcome: 'uncorroborated'
        })
      })
    })

    describe('when the write is a duplicate-key race', () => {
      test('maps an older event that lost the upsert to stale', async () => {
        startedAt(100, T1)
        startedAt(101, T2)

        await controls.apply(pauseEvent('resumed', 101))

        // The filter misses a newer control, so the upsert collides with it.
        expect(await controls.apply(pauseEvent('paused', 100))).toEqual({
          outcome: 'stale'
        })
      })

      test('applies a newer event whose upsert lost the race to an older first write', async () => {
        startedAt(100, T1)
        startedAt(101, T2)

        const real = db.collection('environmentControls')
        let raced = false
        const racing = {
          findOne: (...args) => real.findOne(...args),
          async updateOne(filter, update, options) {
            if (!raced) {
              raced = true
              await real.insertOne({
                _id: 'infradev',
                paused: true,
                runId: 100,
                runStartedAt: T1,
                requestedBy: 'entra:x'
              })

              const error = new Error('E11000 duplicate key')

              error.code = 11000

              throw error
            }

            return real.updateOne(filter, update, options)
          }
        }

        const result = await newControls({ db: dbWith(racing) }).apply(
          pauseEvent('resumed', 101)
        )

        expect(result).toEqual({ outcome: 'applied', paused: false })
        expect(await stored()).toMatchObject({ paused: false, runId: 101 })
      })

      test('maps a duplicate key that has nothing to update to stale', async () => {
        const duplicate = Object.assign(new Error('E11000'), { code: 11000 })
        const racing = {
          findOne: vi.fn(),
          updateOne: vi
            .fn()
            .mockRejectedValueOnce(duplicate)
            .mockResolvedValueOnce({ modifiedCount: 0, upsertedCount: 0 })
        }
        startedAt(100, T1)

        expect(
          await newControls({ db: dbWith(racing) }).apply(
            pauseEvent('paused', 100)
          )
        ).toEqual({ outcome: 'stale' })
      })
    })

    test('treats a write that changed nothing as stale', async () => {
      const unchanged = {
        findOne: vi.fn(),
        updateOne: vi
          .fn()
          .mockResolvedValue({ modifiedCount: 0, upsertedCount: 0 })
      }
      startedAt(100, T1)

      expect(
        await newControls({ db: dbWith(unchanged) }).apply(
          pauseEvent('paused', 100)
        )
      ).toEqual({ outcome: 'stale' })
    })

    test('propagates any other error so the event is redelivered', async () => {
      const failing = {
        findOne: vi.fn(),
        updateOne: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('connection lost'), { code: 6 })
          )
      }
      startedAt(100, T1)

      await expect(
        newControls({ db: dbWith(failing) }).apply(pauseEvent('paused', 100))
      ).rejects.toThrow('connection lost')
    })

    test('propagates a failure of the corroborator', async () => {
      corroborator.corroboratePause.mockRejectedValue(new Error('GitHub down'))

      await expect(controls.apply(pauseEvent('paused', 100))).rejects.toThrow(
        'GitHub down'
      )
      expect(await stored()).toBeNull()
    })
  })
})
