import { MongoClient } from 'mongodb'

import { OID } from '#/common/test-helpers/gitops-messages.js'
import { gitopsSettings } from '#/operations/gitops-settings.js'
import { buildOperation } from '#/operations/operation-factory.js'
import {
  findOperation,
  insertOperation
} from '#/operations/operation-repository.js'
import { createOperationVerifier } from '#/operations/operation-verifier.js'

const DATABASE = 'operation-verifier-test'
const MAX_ATTEMPTS = 5
const RESOURCES = [
  { type: 'azapi_resource.foundry_project', name: 'aip-alpha', id: 'id-1' }
]
const ADD = { entryId: 'entry-1', modelSlug: 'gpt-4o', change: 'add' }
const REMOVE = { entryId: 'entry-2', modelSlug: 'phi-4', change: 'remove' }

describe('operation-verifier', () => {
  const settings = gitopsSettings({ verifyMaxAttempts: MAX_ATTEMPTS })
  let client
  let db
  let verifier
  let operations
  let grantCredentials
  let logger
  let teams = 0

  async function seedDeployed(overrides = {}) {
    teams += 1

    return insertOperation(db, {
      ...buildOperation({
        type: 'team-file.write',
        state: 'deployed',
        teamId: `team-${teams}`,
        environment: 'infradev',
        target: {
          repository: 'DEFRA/ai-platform-tenants',
          team: 'alpha',
          path: 'environments/infradev/alpha.json'
        },
        items: [ADD],
        slot: 'active',
        requestedBy: `entra:${OID}`
      }),
      gitops: { resources: RESOURCES },
      deadlineAt: '2026-10-26T12:00:00.000Z',
      ...overrides
    })
  }

  function build({ database = db, withLogger = true } = {}) {
    return createOperationVerifier({
      ctx: { db: database, settings, logger: withLogger ? logger : undefined },
      verifier,
      operations,
      grantCredentials
    })
  }

  function auditEvents() {
    return db
      .collection('auditEvents')
      .find({})
      .sort({ resourceId: 1 })
      .toArray()
  }

  // A database whose `nth` write (or each of several) to the operations
  // collection is lost to another writer, as a concurrent instance would win it.
  function losingWrite(nth) {
    const lost = [nth].flat()
    let count = 0

    return {
      collection(name) {
        const collection = db.collection(name)

        if (name === 'operations') {
          const original = collection.findOneAndUpdate.bind(collection)

          collection.findOneAndUpdate = async (filter, ...rest) => {
            count += 1

            if (lost.includes(count)) {
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
    await db.collection('auditEvents').deleteMany({})
    logger = { warn: vi.fn(), error: vi.fn() }
    verifier = { verify: vi.fn().mockResolvedValue({ verified: true }) }
    operations = { finish: vi.fn().mockResolvedValue(undefined) }
    grantCredentials = vi.fn().mockResolvedValue(undefined)
  })

  describe('verify', () => {
    describe('an operation that is not deployed', () => {
      test('returns null for an operation that does not exist', async () => {
        expect(await build().verify('missing')).toBeNull()
        expect(verifier.verify).not.toHaveBeenCalled()
      })

      test('returns null and changes nothing for one in another state', async () => {
        const operation = await seedDeployed({ state: 'active' })

        expect(await build().verify(operation._id)).toBeNull()
        expect(verifier.verify).not.toHaveBeenCalled()
        expect(operations.finish).not.toHaveBeenCalled()
        expect((await findOperation(db, operation._id)).stateVersion).toBe(0)
      })
    })

    describe('resources that ARM confirms', () => {
      test('reads the environment and the apply resources back, then ends the operation active', async () => {
        const operation = await seedDeployed()

        const ended = await build().verify(operation._id)

        expect(verifier.verify).toHaveBeenCalledWith({
          environment: 'infradev',
          resources: RESOURCES
        })
        expect(ended.state).toBe('active')
        expect(ended.history.map(({ state }) => state)).toEqual([
          'deployed',
          'verified',
          'active'
        ])
        expect(ended.followUp).toBe('finish')
        expect(Date.parse(ended.deadlineAt)).toBeGreaterThan(Date.now())
        expect(ended.verify).toEqual({ attempts: 0, nextAt: null })
        expect(await findOperation(db, operation._id)).toMatchObject({
          state: 'active',
          stateVersion: 2
        })
      })

      test('finishes the operation and grants the team its credential, once each', async () => {
        const operation = await seedDeployed()

        const ended = await build().verify(operation._id)

        expect(operations.finish).toHaveBeenCalledTimes(1)
        expect(operations.finish).toHaveBeenCalledWith(ended)
        expect(grantCredentials).toHaveBeenCalledTimes(1)
        expect(grantCredentials).toHaveBeenCalledWith(ended)
      })

      test('audits each step of the way for each item', async () => {
        const operation = await seedDeployed({ items: [ADD, REMOVE] })

        await build().verify(operation._id)

        const codes = (await auditEvents()).map(({ resourceId, code }) => [
          resourceId,
          code
        ])

        expect(codes).toEqual([
          ['entry-1', 'verified'],
          ['entry-1', 'active'],
          ['entry-2', 'verified'],
          ['entry-2', 'active']
        ])
      })

      test('sends null resources when the apply reported none', async () => {
        const operation = await seedDeployed({ gitops: {} })

        await build().verify(operation._id)

        expect(verifier.verify).toHaveBeenCalledWith({
          environment: 'infradev',
          resources: null
        })
      })

      test('reads back a write that adds and removes models together, and ends it active', async () => {
        const operation = await seedDeployed({ items: [ADD, REMOVE] })

        const ended = await build().verify(operation._id)

        expect(verifier.verify).toHaveBeenCalledTimes(1)
        expect(ended.state).toBe('active')
        expect(grantCredentials).toHaveBeenCalledTimes(1)
      })
    })

    describe('an operation with nothing to read back', () => {
      test('ends a removal as removed, without asking ARM or granting a credential', async () => {
        const operation = await seedDeployed({ items: [REMOVE] })

        const ended = await build().verify(operation._id)

        expect(verifier.verify).not.toHaveBeenCalled()
        expect(ended.state).toBe('removed')
        expect(operations.finish).toHaveBeenCalledWith(ended)
        expect(grantCredentials).not.toHaveBeenCalled()
      })

      test.each([
        ['a revert', { type: 'team-file.revert', items: [] }],
        ['a pin', { type: 'pin.write', items: [ADD] }],
        ['an empty write', { items: [] }]
      ])('ends %s as active without asking ARM', async (_, overrides) => {
        const operation = await seedDeployed(overrides)

        const ended = await build().verify(operation._id)

        expect(verifier.verify).not.toHaveBeenCalled()
        expect(ended.state).toBe('active')
        expect(grantCredentials).toHaveBeenCalledTimes(1)
      })
    })

    describe('a verification that misses', () => {
      test('stays deployed and sets verify.nextAt 30 s ahead after the first miss', async () => {
        const operation = await seedDeployed()
        verifier.verify.mockResolvedValue({
          verified: false,
          reason: 'resource-unavailable'
        })
        const before = Date.now()

        const written = await build().verify(operation._id)

        expect(written.state).toBe('deployed')
        expect(written.verify).toMatchObject({
          attempts: 1,
          reason: 'resource-unavailable',
          lastAttemptAt: expect.any(String)
        })
        expect(Date.parse(written.verify.nextAt)).toBeGreaterThanOrEqual(
          before + 30000
        )
        expect(Date.parse(written.verify.nextAt)).toBeLessThanOrEqual(
          Date.now() + 30000
        )
        expect(operations.finish).not.toHaveBeenCalled()
        expect(grantCredentials).not.toHaveBeenCalled()
      })

      test.each([
        [1, 60000],
        [2, 120000],
        [3, 240000]
      ])(
        'retries after the %i earlier miss at %i ms',
        async (attempts, delay) => {
          const operation = await seedDeployed({
            verify: { attempts, nextAt: '2026-10-26T12:00:00.000Z' }
          })
          verifier.verify.mockResolvedValue({
            verified: false,
            reason: 'resource-not-succeeded'
          })
          const before = Date.now()

          const written = await build().verify(operation._id)

          expect(written.verify.attempts).toBe(attempts + 1)
          expect(Date.parse(written.verify.nextAt)).toBeGreaterThanOrEqual(
            before + delay
          )
          expect(Date.parse(written.verify.nextAt)).toBeLessThanOrEqual(
            Date.now() + delay
          )
        }
      )

      test('counts from zero when the operation has no verify record', async () => {
        const operation = await seedDeployed()
        await db
          .collection('operations')
          .updateOne({ _id: operation._id }, { $unset: { verify: '' } })
        verifier.verify.mockResolvedValue({ verified: false, reason: 'x' })

        const written = await build().verify(operation._id)

        expect(written.verify.attempts).toBe(1)
      })

      test('records an unknown reason when the verifier gives none', async () => {
        const operation = await seedDeployed()
        verifier.verify.mockResolvedValue({ verified: false })

        const written = await build().verify(operation._id)

        expect(written.verify.reason).toBe('unknown')
      })

      test('audits the miss against each item and warns, without the resource IDs', async () => {
        const operation = await seedDeployed({ items: [ADD, REMOVE] })
        verifier.verify.mockResolvedValue({
          verified: false,
          reason: 'resource-unavailable'
        })

        await build().verify(operation._id)

        expect(
          (await auditEvents()).map(
            ({ resourceId, action, outcome, code, reason }) => ({
              resourceId,
              action,
              outcome,
              code,
              reason
            })
          )
        ).toEqual([
          {
            resourceId: 'entry-1',
            action: 'teamDeployment.verificationFailed',
            outcome: 'failure',
            code: 'resource-unavailable',
            reason: 'attempt 1 of 5'
          },
          {
            resourceId: 'entry-2',
            action: 'teamDeployment.verificationFailed',
            outcome: 'failure',
            code: 'resource-unavailable',
            reason: 'attempt 1 of 5'
          }
        ])
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            operationId: operation._id,
            reason: 'resource-unavailable',
            attempts: 1,
            maxAttempts: MAX_ATTEMPTS
          }),
          'Team deployment verification failed, will verify again'
        )
        expect(logger.error).not.toHaveBeenCalled()
      })

      test('does not fail when no logger is given', async () => {
        const operation = await seedDeployed()
        verifier.verify.mockResolvedValue({ verified: false, reason: 'x' })

        const written = await build({ withLogger: false }).verify(operation._id)

        expect(written.verify.attempts).toBe(1)
      })

      test('ends deploy-failed with operation-verify-failed on the last attempt', async () => {
        const operation = await seedDeployed({
          verify: { attempts: MAX_ATTEMPTS - 1, nextAt: '2026-10-26T12:00:00Z' }
        })
        verifier.verify.mockResolvedValue({
          verified: false,
          reason: 'resource-unavailable'
        })

        const ended = await build().verify(operation._id)

        expect(ended.state).toBe('deploy-failed')
        expect(ended.error).toEqual({
          code: 'operation-verify-failed',
          message: 'resource-unavailable',
          retryable: false
        })
        expect(ended.verify).toMatchObject({
          attempts: MAX_ATTEMPTS,
          reason: 'resource-unavailable',
          nextAt: null
        })
        expect(ended.followUp).toBe('finish')
        expect(ended.history.at(-1)).toMatchObject({
          state: 'deploy-failed',
          source: 'backend'
        })
        expect(operations.finish).toHaveBeenCalledWith(ended)
        expect(grantCredentials).not.toHaveBeenCalled()
      })

      test('reports the last attempt as an error needing a platform engineer', async () => {
        const operation = await seedDeployed({
          verify: { attempts: MAX_ATTEMPTS - 1, nextAt: '2026-10-26T12:00:00Z' }
        })
        verifier.verify.mockResolvedValue({ verified: false, reason: 'x' })

        await build().verify(operation._id)

        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ attempts: MAX_ATTEMPTS, reason: 'x' }),
          'Team deployment verification failed for good and needs a platform engineer'
        )
        expect(logger.warn).not.toHaveBeenCalled()
        expect(
          (await auditEvents()).filter(
            ({ action }) => action === 'teamDeployment.verificationFailed'
          )
        ).toEqual([
          expect.objectContaining({ reason: 'attempt 5 of 5', code: 'x' })
        ])
      })

      test('does not end the operation when the retry write is lost to another writer', async () => {
        const operation = await seedDeployed()
        verifier.verify.mockResolvedValue({ verified: false, reason: 'x' })

        const written = await build({ database: losingWrite(1) }).verify(
          operation._id
        )

        expect(written).toBeNull()
        expect(logger.warn).not.toHaveBeenCalled()
        expect(await auditEvents()).toHaveLength(0)
      })

      test('does not finish the operation when the final write is lost to another writer', async () => {
        const operation = await seedDeployed({
          verify: { attempts: MAX_ATTEMPTS - 1, nextAt: '2026-10-26T12:00:00Z' }
        })
        verifier.verify.mockResolvedValue({ verified: false, reason: 'x' })

        const written = await build({ database: losingWrite(1) }).verify(
          operation._id
        )

        expect(written).toBeNull()
        expect(operations.finish).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
      })
    })

    describe('a race with another verification', () => {
      test('does nothing more when the verified write is lost', async () => {
        const operation = await seedDeployed()

        const result = await build({ database: losingWrite(1) }).verify(
          operation._id
        )

        expect(result).toBeNull()
        expect(operations.finish).not.toHaveBeenCalled()
        expect(grantCredentials).not.toHaveBeenCalled()
      })

      test('still ends the operation when the write ending it loses the version check', async () => {
        const operation = await seedDeployed()

        const result = await build({ database: losingWrite(2) }).verify(
          operation._id
        )

        expect(result).toMatchObject({ state: 'active', followUp: 'finish' })
        expect(operations.finish).toHaveBeenCalledTimes(1)
        expect(grantCredentials).toHaveBeenCalledTimes(1)
        expect(await findOperation(db, operation._id)).toMatchObject({
          state: 'active'
        })
      })

      test('does not finish or grant when another writer moved the operation on instead', async () => {
        const operation = await seedDeployed()
        let count = 0
        const moving = {
          collection(name) {
            const collection = db.collection(name)

            if (name === 'operations') {
              const original = collection.findOneAndUpdate.bind(collection)

              collection.findOneAndUpdate = async (filter, ...rest) => {
                count += 1

                if (count === 2) {
                  await collection.updateOne(
                    { _id: filter._id },
                    { $inc: { stateVersion: 1 }, $set: { state: 'active' } }
                  )
                }

                return original(filter, ...rest)
              }
            }

            return collection
          }
        }

        const result = await build({ database: moving }).verify(operation._id)

        expect(result).toBeNull()
        expect(operations.finish).not.toHaveBeenCalled()
        expect(grantCredentials).not.toHaveBeenCalled()
      })

      test('leaves a verified operation with a deadline for the sweep when the ending write keeps losing', async () => {
        const operation = await seedDeployed()
        const before = Date.now()

        const result = await build({
          database: losingWrite([2, 3, 4])
        }).verify(operation._id)

        const stuck = await findOperation(db, operation._id)

        expect(result).toBeNull()
        expect(stuck.state).toBe('verified')
        expect(Date.parse(stuck.deadlineAt)).toBeGreaterThanOrEqual(
          before + settings.sweepIntervalMs
        )
        expect(operations.finish).not.toHaveBeenCalled()
      })

      test('lets only one of two concurrent verifications finish it', async () => {
        const operation = await seedDeployed()
        const instance = build()

        const results = await Promise.all([
          instance.verify(operation._id),
          instance.verify(operation._id)
        ])

        expect(results.filter(Boolean)).toHaveLength(1)
        expect(operations.finish).toHaveBeenCalledTimes(1)
        expect(grantCredentials).toHaveBeenCalledTimes(1)
        expect((await findOperation(db, operation._id)).state).toBe('active')
      })
    })

    describe('a verified operation, left so by a restart', () => {
      test('keeps the follow-up pending when the projection fails after the ending write', async () => {
        const operation = await seedDeployed()
        let reads = 0
        const failing = {
          collection(name) {
            const collection = db.collection(name)

            if (name === 'teamDeployments') {
              const original = collection.findOne.bind(collection)

              collection.findOne = async (...args) => {
                reads += 1

                if (reads === 2) {
                  throw new Error('projection down')
                }

                return original(...args)
              }
            }

            return collection
          }
        }

        await expect(
          build({ database: failing }).verify(operation._id)
        ).rejects.toThrow('projection down')

        expect(await findOperation(db, operation._id)).toMatchObject({
          state: 'active',
          slot: 'active',
          followUp: 'finish'
        })
        expect(operations.finish).not.toHaveBeenCalled()
      })
      test('is ended active, finished and granted, without reading ARM again', async () => {
        const operation = await seedDeployed({
          state: 'verified',
          deadlineAt: '2026-10-26T12:00:00.000Z'
        })

        const ended = await build().verify(operation._id)

        expect(verifier.verify).not.toHaveBeenCalled()
        expect(ended).toMatchObject({ state: 'active', followUp: 'finish' })
        expect(operations.finish).toHaveBeenCalledWith(ended)
        expect(grantCredentials).toHaveBeenCalledWith(ended)
      })

      test('is ended removed for a removal, granting nothing', async () => {
        const operation = await seedDeployed({
          state: 'verified',
          items: [REMOVE]
        })

        const ended = await build().verify(operation._id)

        expect(ended.state).toBe('removed')
        expect(operations.finish).toHaveBeenCalledWith(ended)
        expect(grantCredentials).not.toHaveBeenCalled()
      })
    })
  })
})
