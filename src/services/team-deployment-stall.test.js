import { randomUUID } from 'node:crypto'

const NOW = Date.parse('2026-10-23T10:30:00Z')
const AFTER_MS = 30 * 60 * 1000

function entryAt(status, since, extra = {}) {
  return {
    id: randomUUID(),
    operationId: randomUUID(),
    status,
    statusTimes: { [status]: since },
    gitops: { path: 'environments/infradev/alpha.json', applyRunId: 2002 },
    ...extra
  }
}

describe('team-deployment-stall', () => {
  let server
  let db
  let stall

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
    stall = await import('#/services/team-deployment-stall.js')
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  describe('looksStalled', () => {
    test.each(['merged', 'deploying'])(
      'is true once %s has lasted the deadline',
      (status) => {
        const entry = entryAt(status, '2026-10-23T10:00:00Z')

        expect(stall.looksStalled(entry, AFTER_MS, NOW)).toBe(true)
      }
    )

    test('is false inside the deadline', () => {
      const entry = entryAt('deploying', '2026-10-23T10:00:01Z')

      expect(stall.looksStalled(entry, AFTER_MS, NOW)).toBe(false)
    })

    test.each(['requested', 'pr-raised', 'deployed', 'active'])(
      'is false at %s, which does not wait on the apply',
      (status) => {
        const entry = entryAt(status, '2026-10-23T08:00:00Z')

        expect(stall.looksStalled(entry, AFTER_MS, NOW)).toBe(false)
      }
    )

    test('is false when switched off with 0', () => {
      const entry = entryAt('deploying', '2026-10-23T08:00:00Z')

      expect(stall.looksStalled(entry, 0, NOW)).toBe(false)
    })

    test('is false once warned at this status', () => {
      const entry = entryAt('deploying', '2026-10-23T08:00:00Z')

      entry.gitops.stalled = { status: 'deploying' }

      expect(stall.looksStalled(entry, AFTER_MS, NOW)).toBe(false)
    })

    test('is false with no recorded start time or no GitOps trail', () => {
      expect(
        stall.looksStalled(
          entryAt('deploying', undefined, { statusTimes: {} }),
          AFTER_MS,
          NOW
        )
      ).toBe(false)
      expect(
        stall.looksStalled(
          entryAt('deploying', '2026-10-23T08:00:00Z', { gitops: null }),
          AFTER_MS,
          NOW
        )
      ).toBe(false)
    })
  })

  describe('reportStall', () => {
    async function insertDocument(entry) {
      const doc = {
        teamId: `stall-team-${randomUUID()}`,
        environment: 'infradev',
        deployments: [entry]
      }
      const { insertedId } = await db
        .collection('teamDeployments')
        .insertOne(doc)

      return { ...doc, _id: insertedId }
    }

    async function stored(doc) {
      const { deployments } = await db
        .collection('teamDeployments')
        .findOne({ _id: doc._id })

      return deployments[0]
    }

    test('warns, audits and records it once, without changing the status', async () => {
      const logger = { warn: vi.fn() }
      const entry = entryAt('deploying', '2020-01-01T00:00:00Z')
      const doc = await insertDocument(entry)
      const settings = { stallWarnAfterMs: AFTER_MS, logger }

      expect(await stall.reportStall(db, doc, entry, settings)).toBe(true)
      expect(await stall.reportStall(db, doc, entry, settings)).toBe(false)

      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith(
        {
          operationId: entry.operationId,
          environment: 'infradev',
          status: 'deploying',
          since: '2020-01-01T00:00:00Z',
          applyRunId: 2002
        },
        expect.stringContaining('looks stalled')
      )
      expect(await stored(doc)).toMatchObject({
        status: 'deploying',
        gitops: {
          stalled: { status: 'deploying', since: '2020-01-01T00:00:00Z' }
        }
      })

      const events = await db
        .collection('auditEvents')
        .find({ resourceId: entry.id })
        .toArray()

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        action: 'teamDeployment.stalled',
        outcome: 'failure',
        code: 'stalled'
      })
    })

    test('keeps the warning and retries the audit event when recording it fails', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() }
      const entry = entryAt('deploying', '2020-01-01T00:00:00Z')
      const doc = await insertDocument(entry)
      const settings = { stallWarnAfterMs: AFTER_MS, logger }
      let failed = false
      const flakyDb = {
        collection(name) {
          if (name !== 'auditEvents') {
            return db.collection(name)
          }

          return {
            async insertOne(event) {
              if (!failed) {
                failed = true
                throw new Error('audit store unavailable')
              }

              return db.collection(name).insertOne(event)
            }
          }
        }
      }
      const eventsFor = () =>
        db.collection('auditEvents').find({ resourceId: entry.id }).toArray()

      expect(await stall.reportStall(flakyDb, doc, entry, settings)).toBe(true)
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(await eventsFor()).toHaveLength(0)
      expect((await stored(doc)).gitops.stalled.audited).toBe(false)

      const reloaded = await stored(doc)

      expect(await stall.reportStall(db, doc, reloaded, settings)).toBe(false)
      expect(await stall.reportStall(db, doc, reloaded, settings)).toBe(false)
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(await eventsFor()).toHaveLength(1)
      expect((await stored(doc)).gitops.stalled.audited).toBe(true)
    })

    test('delivers an owed audit event after the deployment has moved on to another status', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() }
      const entry = entryAt('deploying', '2020-01-01T00:00:00Z')
      const doc = await insertDocument(entry)
      const settings = { stallWarnAfterMs: AFTER_MS, logger }
      const failingAudit = {
        collection(name) {
          return name === 'auditEvents'
            ? {
                insertOne: async () => {
                  throw new Error('audit store unavailable')
                }
              }
            : db.collection(name)
        }
      }

      await stall.reportStall(failingAudit, doc, entry, settings)
      await db
        .collection('teamDeployments')
        .updateOne(
          { _id: doc._id, 'deployments.id': entry.id },
          { $set: { 'deployments.$.status': 'active' } }
        )

      const moved = await stored(doc)

      expect(moved.status).toBe('active')
      expect(await stall.reportStall(db, doc, moved, settings)).toBe(false)

      const events = await db
        .collection('auditEvents')
        .find({ resourceId: entry.id })
        .toArray()

      expect(events).toHaveLength(1)
      expect(events[0].reason).toBe('deploying since 2020-01-01T00:00:00Z')
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })

    test('logs and carries on when its own database write fails', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() }
      const entry = entryAt('deploying', '2020-01-01T00:00:00Z')
      const doc = await insertDocument(entry)
      const failingWrites = {
        collection() {
          return {
            updateOne: async () => {
              throw new Error('mongo unavailable')
            }
          }
        }
      }

      await expect(
        stall.reportStall(failingWrites, doc, entry, {
          stallWarnAfterMs: AFTER_MS,
          logger
        })
      ).resolves.toBe(false)
      expect(logger.warn).toHaveBeenCalledWith(
        { operationId: entry.operationId, message: 'mongo unavailable' },
        expect.stringContaining('the deployment poll carries on')
      )
    })

    test('does nothing for a deployment inside the deadline', async () => {
      const logger = { warn: vi.fn() }
      const entry = entryAt('deploying', new Date().toISOString())
      const doc = await insertDocument(entry)

      const raised = await stall.reportStall(db, doc, entry, {
        stallWarnAfterMs: AFTER_MS,
        logger
      })

      expect(raised).toBe(false)
      expect(logger.warn).not.toHaveBeenCalled()
    })

    test('warns once when two polls race', async () => {
      const logger = { warn: vi.fn() }
      const entry = entryAt('merged', '2020-01-01T00:00:00Z')
      const doc = await insertDocument(entry)
      const settings = { stallWarnAfterMs: AFTER_MS, logger }

      const raised = await Promise.all([
        stall.reportStall(db, doc, entry, settings),
        stall.reportStall(db, doc, entry, settings)
      ])

      expect(raised.filter(Boolean)).toHaveLength(1)
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })

    test('does not warn for an entry that moved on while it was read', async () => {
      const logger = { warn: vi.fn() }
      const entry = entryAt('deploying', '2020-01-01T00:00:00Z')
      const doc = await insertDocument({ ...entry, status: 'deployed' })

      const raised = await stall.reportStall(db, doc, entry, {
        stallWarnAfterMs: AFTER_MS,
        logger
      })

      expect(raised).toBe(false)
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })
})
