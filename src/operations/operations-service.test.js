import { MongoClient } from 'mongodb'

import { Boom, boomWithCode } from '#/common/helpers/boom-with-code.js'
import { OID, SHA } from '#/common/test-helpers/gitops-messages.js'
import { gitopsSettings } from '#/operations/gitops-settings.js'
import { buildOperation } from '#/operations/operation-factory.js'
import {
  createOperationIndexes,
  findOperation,
  insertOperation
} from '#/operations/operation-repository.js'
import {
  createOperationsService,
  SYSTEM_PRINCIPAL
} from '#/operations/operations-service.js'
import { SYSTEM_ACTOR } from '#/services/team-deployment-entries.js'

const DATABASE = 'operations-service-test'
const HELD_MS = 1800000
const REQUESTED_MS = 600000
const RECONCILE_GRACE_MS = 600000
const TARGET = {
  repository: 'DEFRA/ai-platform-tenants',
  team: 'alpha',
  path: 'environments/infradev/alpha.json'
}
const GPT = { entryId: 'entry-1', modelSlug: 'gpt-4o', change: 'add' }
const PHI = { entryId: 'entry-2', modelSlug: 'phi-4', change: 'add' }
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
const CDP_REQUEST = '3f2b8d1c-6a4e-4c7b-9d2a-1e5f0a7b8c9d'

function duplicateKeyError() {
  return Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
}

describe('operations-service', () => {
  const settings = gitopsSettings({
    deadlines: {
      requested: REQUESTED_MS,
      committed: 1800000,
      deploying: 2700000,
      deployed: 900000
    },
    deadlineHeldMs: HELD_MS,
    reconcileGraceMs: RECONCILE_GRACE_MS
  })
  let client
  let db
  let logger
  let relay
  let paused
  let buildDocument
  let reader
  let service
  let teams = 0
  let keys = 0

  function create(overrides = {}) {
    return createOperationsService({
      db,
      settings,
      relay,
      buildDocument,
      reader,
      controls: { isPaused: async () => paused },
      logger,
      ...overrides
    })
  }

  function params(overrides = {}) {
    keys += 1

    return {
      teamId: 'team-a',
      environment: 'infradev',
      target: TARGET,
      items: [GPT],
      requestedBy: `entra:${OID}`,
      requestedByUserId: 'user-1',
      idempotencyKey: `key-${keys}`,
      traceparent: TRACEPARENT,
      cdpRequestId: CDP_REQUEST,
      ...overrides
    }
  }

  async function seed(state, overrides = {}) {
    teams += 1

    return insertOperation(db, {
      ...buildOperation({
        type: 'team-file.write',
        state,
        teamId: `team-s${teams}`,
        environment: 'infradev',
        target: TARGET,
        items: [GPT],
        slot: 'active',
        requestedBy: `entra:${OID}`,
        traceparent: TRACEPARENT,
        cdpRequestId: CDP_REQUEST
      }),
      ...Object.fromEntries(
        Object.entries(overrides).filter(([, value]) => value !== undefined)
      )
    })
  }

  function stored(id) {
    return findOperation(db, id)
  }

  function expectDueIn(deadlineAt, ms, before) {
    expect(Date.parse(deadlineAt)).toBeGreaterThanOrEqual(before + ms)
    expect(Date.parse(deadlineAt)).toBeLessThanOrEqual(Date.now() + ms)
  }

  function entryTypes(operation) {
    return operation.outbox.map(({ type }) => type)
  }

  // A database whose operations collection loses its first `losses` writes
  // to another writer, as a concurrent instance would win them.
  function losing(losses) {
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

  // A database whose inserts into operations always fail with `error`.
  function failingInserts(error) {
    return {
      collection(name) {
        const collection = db.collection(name)

        if (name === 'operations') {
          collection.insertOne = async () => {
            throw error
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
    for (const name of ['operations', 'teamDeployments', 'auditEvents']) {
      await db.collection(name).deleteMany({})
    }

    paused = false
    logger = { warn: vi.fn(), error: vi.fn() }
    relay = { publishOperation: vi.fn().mockResolvedValue(1) }
    buildDocument = vi.fn(async (operation) => ({
      document: {
        environment: operation.environment,
        revision: 3,
        models: operation.items.map(({ modelSlug }) => modelSlug)
      },
      expectedRevision: 2
    }))
    reader = {
      getPreviousDocument: vi.fn().mockResolvedValue({ document: null })
    }
    service = create()
  })

  test('attributes the backend’s own operations to the system actor', () => {
    expect(SYSTEM_PRINCIPAL).toBe(SYSTEM_ACTOR)
  })

  describe('request', () => {
    describe('a free file', () => {
      test('gets an active operation with its document built and a submit command in the outbox', async () => {
        const before = Date.now()
        const input = params()

        const result = await service.request(input)

        const { operation } = result
        const persisted = await stored(operation._id)

        expect(result).toMatchObject({ replay: false, waiting: false })
        expect(persisted).toMatchObject({
          type: 'team-file.write',
          teamId: 'team-a',
          environment: 'infradev',
          target: TARGET,
          items: [GPT],
          state: 'requested',
          slot: 'active',
          attempt: 1,
          idempotencyKeys: [input.idempotencyKey],
          requestedBy: input.requestedBy,
          requestedByUserId: 'user-1',
          traceparent: TRACEPARENT,
          cdpRequestId: CDP_REQUEST,
          expectedRevision: 2,
          revision: 3,
          outboxPending: true
        })
        expect(JSON.parse(persisted.document)).toEqual({
          environment: 'infradev',
          models: ['gpt-4o'],
          revision: 3
        })
        expect(persisted.outbox).toEqual([
          expect.objectContaining({
            type: 'submit',
            attempt: 1,
            publishedAt: null
          })
        ])
        expectDueIn(persisted.deadlineAt, REQUESTED_MS, before)
        expect(buildDocument).toHaveBeenCalledTimes(1)
      })

      test('publishes the command straight away', async () => {
        const { operation } = await service.request(params())

        expect(relay.publishOperation).toHaveBeenCalledWith(operation._id)
      })

      test('still accepts the request when publishing fails, leaving it to the sweep', async () => {
        relay.publishOperation.mockRejectedValue(new Error('queue down'))

        const { operation } = await service.request(params())

        expect((await stored(operation._id)).outboxPending).toBe(true)
        expect(logger.warn).toHaveBeenCalledWith(
          { operationId: operation._id, message: 'queue down' },
          'Publishing after the write failed, the sweep will retry'
        )
      })

      test('works without a logger when publishing fails', async () => {
        relay.publishOperation.mockRejectedValue(new Error('queue down'))
        service = create({ logger: undefined })

        const { operation } = await service.request(params())

        expect(operation.state).toBe('requested')
      })

      test('is held, with no document built or published, while the environment is paused', async () => {
        paused = true
        const before = Date.now()

        const { operation, waiting } = await service.request(params())

        const held = await stored(operation._id)

        expect(waiting).toBe(false)
        expect(held).toMatchObject({
          state: 'queued',
          slot: 'active',
          held: { code: 'paused', since: expect.any(String) }
        })
        expect(held.outbox).toEqual([])
        expect(held.document).toBeUndefined()
        expectDueIn(held.deadlineAt, HELD_MS, before)
        expect(buildDocument).not.toHaveBeenCalled()
      })

      test('writes nothing when the document cannot be built', async () => {
        buildDocument.mockRejectedValue(
          boomWithCode(Boom.badRequest, 'No SKU', 'model-not-eligible')
        )

        await expect(service.request(params())).rejects.toThrow('No SKU')

        expect(await db.collection('operations').countDocuments()).toBe(0)
        expect(relay.publishOperation).not.toHaveBeenCalled()
      })
    })

    describe('a busy file', () => {
      test('gets a waiting operation holding only its items', async () => {
        const { operation: active } = await service.request(params())

        const result = await service.request(params({ items: [PHI] }))

        const waiting = await stored(result.operation._id)

        expect(result).toMatchObject({ replay: false, waiting: true })
        expect(waiting).toMatchObject({
          state: 'queued',
          slot: 'waiting',
          items: [PHI]
        })
        expect(waiting.document).toBeUndefined()
        expect(waiting.outbox).toEqual([])
        expect(waiting._id).not.toBe(active._id)
        expect(buildDocument).toHaveBeenCalledTimes(1)
      })

      test('merges later requests into the waiting operation, keeping every key', async () => {
        await service.request(params())
        const second = params({ items: [PHI] })
        const third = params({
          items: [{ entryId: 'entry-3', modelSlug: 'o3', change: 'remove' }]
        })

        const first = await service.request(second)
        const merged = await service.request(third)

        const waiting = await stored(first.operation._id)

        expect(merged.operation._id).toBe(first.operation._id)
        expect(merged.waiting).toBe(true)
        expect(waiting.items.map(({ modelSlug }) => modelSlug)).toEqual([
          'phi-4',
          'o3'
        ])
        expect(waiting.idempotencyKeys).toEqual([
          second.idempotencyKey,
          third.idempotencyKey
        ])
        expect(waiting.stateVersion).toBe(1)
        expect(await db.collection('operations').countDocuments()).toBe(2)
      })

      test('looks again when the merge is lost to another writer', async () => {
        await service.request(params())
        await service.request(params({ items: [PHI] }))
        service = create({ db: losing(1) })

        const { operation } = await service.request(
          params({
            items: [{ entryId: 'entry-3', modelSlug: 'o3', change: 'add' }]
          })
        )

        expect((await stored(operation._id)).items).toHaveLength(2)
      })

      test('gives up with team-file-busy when it keeps losing', async () => {
        await service.request(params())
        await service.request(params({ items: [PHI] }))
        service = create({ db: losing(99) })

        await expect(service.request(params())).rejects.toMatchObject({
          output: { statusCode: 409 },
          data: { code: 'team-file-busy' }
        })
      })

      test('keeps a file of another team, or another environment, separate', async () => {
        await service.request(params())

        const otherTeam = await service.request(params({ teamId: 'team-b' }))
        const otherEnvironment = await service.request(
          params({ environment: 'sandbox' })
        )

        expect(otherTeam.waiting).toBe(false)
        expect(otherEnvironment.waiting).toBe(false)
      })
    })

    describe('a replayed idempotency key', () => {
      test('finds the operation it created, writing nothing', async () => {
        const input = params()
        const first = await service.request(input)

        const again = await service.request(input)

        expect(again.replay).toBe(true)
        expect(again.waiting).toBe(false)
        expect(again.operation._id).toBe(first.operation._id)
        expect(buildDocument).toHaveBeenCalledTimes(1)
        expect(await db.collection('operations').countDocuments()).toBe(1)
      })

      test('finds the waiting operation a merged request joined', async () => {
        await service.request(params())
        const second = params({ items: [PHI] })
        const third = params({ items: [GPT] })
        const waiting = await service.request(second)
        await service.request(third)

        const again = await service.request(third)

        expect(again).toMatchObject({ replay: true, waiting: true })
        expect(again.operation._id).toBe(waiting.operation._id)
      })

      test('is scoped to the team: another team with the same key is a new request', async () => {
        const input = params()
        await service.request(input)

        const other = await service.request({ ...input, teamId: 'team-b' })

        expect(other.replay).toBe(false)
      })
    })

    describe('races on the file', () => {
      test('gives one active and one merged waiting operation for three at once', async () => {
        const results = await Promise.all([
          service.request(params({ items: [GPT] })),
          service.request(params({ items: [PHI] })),
          service.request(
            params({
              items: [{ entryId: 'entry-3', modelSlug: 'o3', change: 'add' }]
            })
          )
        ])

        const operations = await db.collection('operations').find({}).toArray()
        const active = operations.filter(({ slot }) => slot === 'active')
        const waiting = operations.filter(({ slot }) => slot === 'waiting')

        expect(results).toHaveLength(3)
        expect(active).toHaveLength(1)
        expect(waiting).toHaveLength(1)
        expect(active[0].items.length + waiting[0].items.length).toBe(3)
      })

      test('throws team-file-busy when the slot is always taken first', async () => {
        service = create({ db: failingInserts(duplicateKeyError()) })

        await expect(service.request(params())).rejects.toMatchObject({
          output: { statusCode: 409 },
          data: { code: 'team-file-busy' }
        })
      })

      test('rethrows an insert failure that is not a duplicate key', async () => {
        service = create({ db: failingInserts(new Error('disk full')) })

        await expect(service.request(params())).rejects.toThrow('disk full')
      })
    })
  })

  describe('promoteWaiting', () => {
    function waitingFor(active, overrides = {}) {
      return seed('queued', {
        slot: 'waiting',
        teamId: active.teamId,
        items: [PHI],
        ...overrides
      })
    }

    test('returns null when nothing waits', async () => {
      expect(
        await service.promoteWaiting({
          environment: 'infradev',
          teamId: 'nobody'
        })
      ).toBeNull()
    })

    test('builds the document now and gives the file to the waiting operation', async () => {
      const ended = await seed('active')
      await db
        .collection('operations')
        .updateOne({ _id: ended._id }, { $unset: { slot: '' } })
      const waiting = await waitingFor(ended)
      const before = Date.now()

      const promoted = await service.promoteWaiting({
        environment: 'infradev',
        teamId: ended.teamId
      })

      const persisted = await stored(waiting._id)

      expect(promoted._id).toBe(waiting._id)
      expect(persisted).toMatchObject({
        state: 'requested',
        slot: 'active',
        expectedRevision: 2,
        outboxPending: true
      })
      expect(persisted.history.at(-1)).toMatchObject({
        state: 'requested',
        source: 'backend'
      })
      expect(entryTypes(persisted)).toEqual(['submit'])
      expectDueIn(persisted.deadlineAt, REQUESTED_MS, before)
      expect(buildDocument).toHaveBeenCalledWith(
        expect.objectContaining({ _id: waiting._id })
      )
      expect(relay.publishOperation).toHaveBeenCalledWith(waiting._id)
    })

    test('holds the promoted operation instead when the environment is paused', async () => {
      paused = true
      const ended = await seed('active')
      await db
        .collection('operations')
        .updateOne({ _id: ended._id }, { $unset: { slot: '' } })
      const waiting = await waitingFor(ended)
      const before = Date.now()

      await service.promoteWaiting({
        environment: 'infradev',
        teamId: ended.teamId
      })

      const persisted = await stored(waiting._id)

      expect(persisted).toMatchObject({
        slot: 'active',
        state: 'queued',
        held: { code: 'paused', since: expect.any(String) }
      })
      expectDueIn(persisted.deadlineAt, HELD_MS, before)
      expect(buildDocument).not.toHaveBeenCalled()
      expect(relay.publishOperation).not.toHaveBeenCalled()
    })

    test('returns null and leaves the waiting operation when the file is still held', async () => {
      const active = await seed('committed')
      const waiting = await waitingFor(active)

      const result = await service.promoteWaiting({
        environment: 'infradev',
        teamId: active.teamId
      })

      expect(result).toBeNull()
      expect((await stored(waiting._id)).slot).toBe('waiting')
    })

    test.each([
      [
        'a coded error',
        () => boomWithCode(Boom.badRequest, 'No SKU', 'model-not-eligible')
      ],
      [
        'a plain error with a code',
        () =>
          Object.assign(new Error('Too big'), {
            code: 'desired-state-too-large'
          })
      ]
    ])(
      'ends the waiting operation refused when its document can no longer be built (%s)',
      async (_, makeError) => {
        const ended = await seed('active')
        await db
          .collection('operations')
          .updateOne({ _id: ended._id }, { $unset: { slot: '' } })
        const waiting = await waitingFor(ended)
        buildDocument.mockRejectedValue(makeError())

        const result = await service.promoteWaiting({
          environment: 'infradev',
          teamId: ended.teamId
        })

        const persisted = await stored(waiting._id)

        expect(result.state).toBe('checks-failed')
        expect(persisted).toMatchObject({
          state: 'checks-failed',
          error: { code: 'operation-checks-failed', retryable: false }
        })
        expect(persisted.error.message).toEqual(expect.any(String))
        expect(persisted.slot).toBeUndefined()
        expect(relay.publishOperation).not.toHaveBeenCalled()
      }
    )

    test('rethrows any other failure to build, leaving the operation waiting', async () => {
      const ended = await seed('active')
      await db
        .collection('operations')
        .updateOne({ _id: ended._id }, { $unset: { slot: '' } })
      const waiting = await waitingFor(ended)
      buildDocument.mockRejectedValue(new Error('GitHub unavailable'))

      await expect(
        service.promoteWaiting({
          environment: 'infradev',
          teamId: ended.teamId
        })
      ).rejects.toThrow('GitHub unavailable')

      expect((await stored(waiting._id)).slot).toBe('waiting')
    })

    test('returns null when the move is lost to another instance', async () => {
      const ended = await seed('active')
      await db
        .collection('operations')
        .updateOne({ _id: ended._id }, { $unset: { slot: '' } })
      const waiting = await waitingFor(ended)
      service = create({ db: losing(1) })

      const result = await service.promoteWaiting({
        environment: 'infradev',
        teamId: ended.teamId
      })

      expect(result).toBeNull()
      expect((await stored(waiting._id)).slot).toBe('waiting')
      expect(relay.publishOperation).not.toHaveBeenCalled()
    })
  })

  describe('finish', () => {
    test('frees the file of an ended operation and promotes the waiting one', async () => {
      const ended = await seed('active', { deadlineAt: '2030-01-01T00:00:00Z' })
      const waiting = await seed('queued', {
        slot: 'waiting',
        teamId: ended.teamId,
        items: [PHI]
      })

      await service.finish(ended)

      expect(await stored(ended._id)).toMatchObject({ deadlineAt: null })
      expect((await stored(ended._id)).slot).toBeUndefined()
      expect(await stored(waiting._id)).toMatchObject({
        slot: 'active',
        state: 'requested'
      })
    })

    test('frees the file when nothing waits', async () => {
      const ended = await seed('checks-failed')

      await service.finish(ended)

      expect((await stored(ended._id)).slot).toBeUndefined()
      expect(relay.publishOperation).not.toHaveBeenCalled()
    })

    test('does nothing for an operation that holds no slot', async () => {
      const ended = await seed('active')
      await db
        .collection('operations')
        .updateOne({ _id: ended._id }, { $unset: { slot: '' } })
      const unslotted = await stored(ended._id)

      await service.finish(unslotted)

      expect((await stored(ended._id)).stateVersion).toBe(0)
    })

    test('does nothing more when another writer freed the slot already', async () => {
      const ended = await seed('active')

      await service.finish(ended)
      await service.finish(ended)

      expect((await stored(ended._id)).stateVersion).toBe(1)
    })

    test('does not promote the waiting operation when a revert ends: the failed parent keeps the file', async () => {
      const parent = await seed('deploy-failed', { revertId: 'child' })
      const waiting = await seed('queued', {
        slot: 'waiting',
        teamId: parent.teamId,
        items: [PHI]
      })
      const child = await seed('checks-failed', {
        type: 'team-file.revert',
        slot: 'revert',
        teamId: parent.teamId,
        parentId: parent._id,
        items: []
      })

      await service.finish(child)

      expect((await stored(child._id)).slot).toBeUndefined()
      expect((await stored(waiting._id)).slot).toBe('waiting')
    })

    describe('the end of a revert', () => {
      async function parentWithRevert(childState) {
        const parent = await seed('deploy-failed', {
          revertId: 'op-child-1',
          retrying: true,
          error: {
            code: 'operation-deploy-failed',
            message: 'm',
            retryable: false
          }
        })
        const child = await seed(childState, {
          _id: 'op-child-1',
          type: 'team-file.revert',
          slot: 'revert',
          teamId: parent.teamId,
          parentId: parent._id,
          items: []
        })

        return { parent, child }
      }

      test('settles the parent as reverted and frees its file when the revert landed', async () => {
        const { parent, child } = await parentWithRevert('active')
        const waiting = await seed('queued', {
          slot: 'waiting',
          teamId: parent.teamId,
          items: [PHI]
        })

        await service.finish(child)

        const settled = await stored(parent._id)

        expect(settled.error).toEqual({
          code: 'operation-reverted',
          message: 'The failed change was reverted',
          retryable: false
        })
        expect(settled.revertId).toBeUndefined()
        expect(settled.retrying).toBeUndefined()
        expect(settled.slot).toBeUndefined()
        expect(settled.state).toBe('deploy-failed')
        expect(await stored(waiting._id)).toMatchObject({ slot: 'active' })
      })

      test('leaves the file with the parent, flagged, when the revert failed', async () => {
        const { parent, child } = await parentWithRevert('deploy-failed')

        await service.finish(child)

        const settled = await stored(parent._id)

        expect(settled.revertFailed).toBe(true)
        expect(settled.revertId).toBeUndefined()
        expect(settled.slot).toBe('active')
        expect(settled.error.code).toBe('operation-deploy-failed')
        expect(logger.error).toHaveBeenCalledWith(
          {
            operationId: parent._id,
            revertOperationId: 'op-child-1'
          },
          'The revert did not complete: the file stays with the failed operation and needs a platform engineer'
        )
      })

      test('settles a failed revert without a logger', async () => {
        const { parent, child } = await parentWithRevert('timed-out')
        service = create({ logger: undefined })

        await service.finish(child)

        expect((await stored(parent._id)).revertFailed).toBe(true)
      })
    })
  })

  describe('resubmit', () => {
    function held(overrides = {}) {
      return seed('queued', {
        held: { code: 'stale-revision', since: '2026-10-26T12:00:00Z' },
        deferred: undefined,
        ...overrides
      })
    }

    test('returns null for an operation that does not exist or holds no slot', async () => {
      const ended = await seed('active')
      await db
        .collection('operations')
        .updateOne({ _id: ended._id }, { $unset: { slot: '' } })

      expect(await service.resubmit('missing')).toBeNull()
      expect(await service.resubmit(ended._id)).toBeNull()
      expect(buildDocument).not.toHaveBeenCalled()
    })

    test('rebuilds the document from main and publishes a fresh submit', async () => {
      const operation = await held({ document: 'old', expectedRevision: 1 })
      const before = Date.now()

      const written = await service.resubmit(operation._id)

      const persisted = await stored(operation._id)

      expect(written._id).toBe(operation._id)
      expect(persisted).toMatchObject({
        state: 'requested',
        expectedRevision: 2,
        revision: 3,
        outboxPending: true
      })
      expect(persisted.document).not.toBe('old')
      expect(persisted.held).toBeUndefined()
      expect(persisted.history.at(-1)).toMatchObject({
        state: 'requested',
        source: 'backend'
      })
      expect(entryTypes(persisted)).toEqual(['submit'])
      expectDueIn(persisted.deadlineAt, REQUESTED_MS, before)
      expect(relay.publishOperation).toHaveBeenCalledWith(operation._id)
    })

    test('does not count the resubmission unless asked to', async () => {
      const operation = await held({ resubmitCount: 1 })

      await service.resubmit(operation._id)

      expect((await stored(operation._id)).resubmitCount).toBe(1)
    })

    test.each([
      [undefined, 1],
      [1, 2]
    ])(
      'counts a resubmission after %s earlier ones when counted',
      async (earlier, expected) => {
        const operation = await held(
          earlier === undefined ? {} : { resubmitCount: earlier }
        )

        await service.resubmit(operation._id, { counted: true })

        expect((await stored(operation._id)).resubmitCount).toBe(expected)
      }
    )

    test('clears a deferred marker as well', async () => {
      const operation = await seed('deploying', { deferred: 'retry' })

      await service.resubmit(operation._id)

      expect((await stored(operation._id)).deferred).toBeUndefined()
    })

    test('ends the operation refused when its document cannot be built any longer', async () => {
      const operation = await held()
      const waiting = await seed('queued', {
        slot: 'waiting',
        teamId: operation.teamId,
        items: [PHI]
      })
      buildDocument.mockRejectedValueOnce(
        boomWithCode(
          Boom.badRequest,
          'Service code needed',
          'service-code-required'
        )
      )

      const result = await service.resubmit(operation._id)

      const persisted = await stored(operation._id)

      expect(result.state).toBe('checks-failed')
      expect(persisted.error).toEqual({
        code: 'operation-checks-failed',
        message: 'Service code needed',
        retryable: false
      })
      expect(persisted.held).toBeUndefined()
      expect(persisted.slot).toBeUndefined()
      expect((await stored(waiting._id)).slot).toBe('active')
    })

    test('rethrows a failure to build that is not a refusal', async () => {
      const operation = await held()
      buildDocument.mockRejectedValue(new Error('GitHub unavailable'))

      await expect(service.resubmit(operation._id)).rejects.toThrow(
        'GitHub unavailable'
      )
      expect((await stored(operation._id)).state).toBe('queued')
    })

    test('reads again and writes when another writer moved the operation first', async () => {
      const operation = await held()
      service = create({ db: losing(2) })

      await service.resubmit(operation._id)

      expect((await stored(operation._id)).state).toBe('requested')
      expect(buildDocument).toHaveBeenCalledTimes(3)
    })

    test('throws when the operation keeps moving', async () => {
      const operation = await held()
      service = create({ db: losing(99) })

      await expect(service.resubmit(operation._id)).rejects.toThrow(
        `Operation ${operation._id} kept moving; try again`
      )
    })
  })

  describe('publishApply', () => {
    test('puts a fresh apply at the same attempt in the outbox and publishes it', async () => {
      const operation = await seed('deploying', {
        attempt: 2,
        deferred: 'retry',
        held: { code: 'paused', since: '2026-10-26T12:00:00Z' }
      })

      const written = await service.publishApply(operation._id)

      const persisted = await stored(operation._id)

      expect(written._id).toBe(operation._id)
      expect(persisted).toMatchObject({
        state: 'deploying',
        attempt: 2,
        retrying: true,
        outboxPending: true
      })
      expect(persisted.deferred).toBeUndefined()
      expect(persisted.held).toBeUndefined()
      expect(persisted.outbox).toEqual([
        expect.objectContaining({ type: 'apply', attempt: 2 })
      ])
      expect(relay.publishOperation).toHaveBeenCalledWith(operation._id)
    })

    test('uses the attempt it is given', async () => {
      const operation = await seed('deploy-failed', { attempt: 1 })

      await service.publishApply(operation._id, { attempt: 2 })

      const persisted = await stored(operation._id)

      expect(persisted.attempt).toBe(2)
      expect(persisted.outbox[0]).toMatchObject({ type: 'apply', attempt: 2 })
      expect(persisted.state).toBe('deploy-failed')
    })

    test('moves it to the state given, as the backend, and resets verification and the error', async () => {
      const operation = await seed('deploy-failed', {
        attempt: 1,
        verify: { attempts: 4, nextAt: '2026-10-26T12:00:00Z', reason: 'x' },
        error: {
          code: 'operation-verify-failed',
          message: 'm',
          retryable: false
        }
      })

      await service.publishApply(operation._id, {
        attempt: 2,
        state: 'deploying',
        reset: true
      })

      const persisted = await stored(operation._id)

      expect(persisted.state).toBe('deploying')
      expect(persisted.verify).toEqual({ attempts: 0, nextAt: null })
      expect(persisted.error).toBeUndefined()
      expect(persisted.history.at(-1)).toMatchObject({
        state: 'deploying',
        source: 'backend'
      })
    })

    test('keeps the verification count and error when not reset', async () => {
      const operation = await seed('deployed', {
        verify: { attempts: 2, nextAt: null },
        error: { code: 'c', message: 'm', retryable: false }
      })

      await service.publishApply(operation._id)

      const persisted = await stored(operation._id)

      expect(persisted.verify.attempts).toBe(2)
      expect(persisted.error).toBeDefined()
    })

    test('returns null and publishes nothing for an operation that does not exist', async () => {
      expect(await service.publishApply('missing')).toBeNull()
      expect(relay.publishOperation).not.toHaveBeenCalled()
    })

    test('writes again when another writer moved the operation first', async () => {
      const operation = await seed('deploying')
      service = create({ db: losing(1) })

      await service.publishApply(operation._id)

      expect(entryTypes(await stored(operation._id))).toEqual(['apply'])
    })
  })

  describe('reconcile', () => {
    test('adds a reconcile command carrying the state, and publishes it', async () => {
      const operation = await seed('committed', { reconcileCount: 0 })

      const written = await service.reconcile(operation._id)

      const persisted = await stored(operation._id)

      expect(written._id).toBe(operation._id)
      expect(persisted.outbox).toEqual([
        expect.objectContaining({ type: 'reconcile', state: 'committed' })
      ])
      expect(persisted.outboxPending).toBe(true)
      expect(persisted.reconcileCount).toBe(0)
      expect(persisted.deadlineAt).toBeUndefined()
      expect(relay.publishOperation).toHaveBeenCalledWith(operation._id)
    })

    test.each([
      [undefined, 1],
      [1, 2]
    ])(
      'extends the deadline and counts it when asked, after %s before',
      async (earlier, expected) => {
        const operation = await seed('deploying')
        const operations = db.collection('operations')

        if (earlier === undefined) {
          await operations.updateOne(
            { _id: operation._id },
            { $unset: { reconcileCount: '' } }
          )
        } else {
          await operations.updateOne(
            { _id: operation._id },
            { $set: { reconcileCount: earlier } }
          )
        }

        const before = Date.now()

        await service.reconcile(operation._id, { extendDeadline: true })

        const persisted = await stored(operation._id)

        expect(persisted.reconcileCount).toBe(expected)
        expectDueIn(persisted.deadlineAt, RECONCILE_GRACE_MS, before)
      }
    )

    test('returns null for an operation that does not exist', async () => {
      expect(await service.reconcile('missing')).toBeNull()
    })
  })

  describe('startRevert', () => {
    function failedParent(overrides = {}) {
      return seed('deploy-failed', {
        attempt: 2,
        deferred: 'revert',
        revision: 4,
        gitops: { commitSha: SHA, applyRunId: 25000000011 },
        lastFailure: { runId: 25000000011, runAttempt: 1 },
        ...overrides
      })
    }

    function childOf(parent) {
      return db.collection('operations').findOne({ parentId: parent._id })
    }

    test('creates a child revert with the file as it was before the commit, and links it to the parent', async () => {
      const parent = await failedParent()
      reader.getPreviousDocument.mockResolvedValue({
        document: { environment: 'infradev', revision: 3, models: [] }
      })
      const before = Date.now()

      const outcome = await service.startRevert(parent)

      const child = await childOf(parent)
      const persisted = await stored(parent._id)

      expect(outcome).toBe('started')
      expect(reader.getPreviousDocument).toHaveBeenCalledWith({
        path: TARGET.path,
        commitSha: SHA
      })
      expect(child).toMatchObject({
        type: 'team-file.revert',
        state: 'requested',
        slot: 'revert',
        action: 'revert',
        parentId: parent._id,
        teamId: parent.teamId,
        environment: 'infradev',
        target: TARGET,
        items: [],
        requestedBy: SYSTEM_PRINCIPAL,
        requestedByUserId: SYSTEM_PRINCIPAL,
        traceparent: TRACEPARENT,
        cdpRequestId: CDP_REQUEST,
        expectedRevision: 4,
        outboxPending: true
      })
      expect(JSON.parse(child.document)).toEqual({
        environment: 'infradev',
        models: [],
        operationId: child._id,
        revision: 5,
        updatedAt: expect.any(String),
        updatedBy: SYSTEM_PRINCIPAL
      })
      expect(child.outbox).toEqual([
        expect.objectContaining({ type: 'submit', attempt: 1 })
      ])
      expectDueIn(child.deadlineAt, REQUESTED_MS, before)
      expect(persisted).toMatchObject({ revertId: child._id, deadlineAt: null })
      expect(persisted.deferred).toBeUndefined()
      expect(persisted.slot).toBe('active')
      expect(relay.publishOperation).toHaveBeenCalledWith(child._id)
    })

    test('removes the file when it did not exist before the commit', async () => {
      const parent = await failedParent({ revision: undefined })

      await service.startRevert(parent)

      const child = await childOf(parent)

      expect(child.action).toBe('remove')
      expect(child.document).toBeUndefined()
      expect(child.expectedRevision).toBe(0)
    })

    test('numbers the revert 1 for a parent with no revision', async () => {
      const parent = await failedParent({ revision: undefined })
      reader.getPreviousDocument.mockResolvedValue({
        document: { environment: 'infradev', revision: 0 }
      })

      await service.startRevert(parent)

      expect(JSON.parse((await childOf(parent)).document).revision).toBe(1)
    })

    test('cancels when the parent is no longer failed', async () => {
      const parent = await failedParent({ state: 'deployed' })

      const outcome = await service.startRevert(parent)

      expect(outcome).toBe('cancelled')
      expect(await childOf(parent)).toBeNull()
      expect((await stored(parent._id)).deferred).toBeUndefined()
      expect(logger.warn).toHaveBeenCalledWith(
        { operationId: parent._id, code: 'operation-revert-cancelled' },
        'The revert was cancelled: the failed apply moved on'
      )
    })

    test('cancels when a newer apply attempt is running', async () => {
      const parent = await failedParent({
        gitops: { commitSha: SHA, applyRunId: 25000000012 }
      })

      expect(await service.startRevert(parent)).toBe('cancelled')
      expect(await childOf(parent)).toBeNull()
    })

    test('works out the newer attempt only when a failure was recorded', async () => {
      const parent = await failedParent({ lastFailure: undefined })

      expect(await service.startRevert(parent)).toBe('started')
    })

    test('re-arms with a doubled deadline while the environment is paused', async () => {
      paused = true
      const parent = await failedParent({ heldPasses: 1 })
      const before = Date.now()

      const outcome = await service.startRevert(parent)

      const persisted = await stored(parent._id)

      expect(outcome).toBe('re-armed')
      expect(persisted).toMatchObject({ heldPasses: 2, deferred: 'revert' })
      expectDueIn(persisted.deadlineAt, HELD_MS * 4, before)
      expect(await childOf(parent)).toBeNull()
    })

    test('counts the first paused pass from none', async () => {
      paused = true
      const parent = await failedParent()

      await service.startRevert(parent)

      expect((await stored(parent._id)).heldPasses).toBe(1)
    })

    test('works without a logger when cancelling', async () => {
      const parent = await failedParent({ state: 'active' })
      service = create({ logger: undefined })

      expect(await service.startRevert(parent)).toBe('cancelled')
    })
  })

  describe('retry', () => {
    test('refuses an operation that is not failed, timed out or held', async () => {
      const operation = await seed('committed')

      await expect(service.retry(operation)).rejects.toMatchObject({
        output: { statusCode: 409 },
        data: { code: 'deployment-not-retryable' }
      })
    })

    test('gives a failed apply a fresh apply at the next attempt, starting verification again', async () => {
      const operation = await seed('deploy-failed', {
        attempt: 2,
        verify: { attempts: 3, nextAt: null },
        error: {
          code: 'operation-deploy-failed',
          message: 'm',
          retryable: false
        }
      })

      const written = await service.retry(operation)

      const persisted = await stored(operation._id)

      expect(written._id).toBe(operation._id)
      expect(persisted).toMatchObject({
        state: 'deploying',
        attempt: 3,
        retrying: true,
        verify: { attempts: 0, nextAt: null }
      })
      expect(persisted.error).toBeUndefined()
      expect(persisted.outbox).toEqual([
        expect.objectContaining({ type: 'apply', attempt: 3 })
      ])
    })

    test('resumes a timed-out operation from the state it left, with an apply after commit', async () => {
      const operation = await seed('timed-out', {
        leftState: 'deploying',
        attempt: 2
      })

      await service.retry(operation)

      const persisted = await stored(operation._id)

      expect(persisted).toMatchObject({ state: 'deploying', attempt: 2 })
      expect(persisted.leftState).toBeUndefined()
      expect(entryTypes(persisted)).toEqual(['apply'])
    })

    test('resubmits a timed-out operation that left before the commit', async () => {
      const operation = await seed('timed-out', { leftState: 'requested' })

      await service.retry(operation)

      const persisted = await stored(operation._id)

      expect(persisted.state).toBe('requested')
      expect(entryTypes(persisted)).toEqual(['submit'])
      expect(buildDocument).toHaveBeenCalledTimes(1)
    })

    test('resubmits a held write', async () => {
      const operation = await seed('queued', {
        held: { code: 'paused', since: '2026-10-26T12:00:00Z' }
      })

      await service.retry(operation)

      const persisted = await stored(operation._id)

      expect(persisted.state).toBe('requested')
      expect(persisted.held).toBeUndefined()
    })

    test('takes the file again for an operation that ended and gave it up', async () => {
      const operation = await seed('deploy-failed')
      await db
        .collection('operations')
        .updateOne({ _id: operation._id }, { $unset: { slot: '' } })
      const ended = await stored(operation._id)

      await service.retry(ended)

      expect(await stored(operation._id)).toMatchObject({
        slot: 'active',
        state: 'deploying'
      })
    })

    test('refuses with team-file-busy when another operation holds the file', async () => {
      const operation = await seed('deploy-failed')
      await db
        .collection('operations')
        .updateOne({ _id: operation._id }, { $unset: { slot: '' } })
      await seed('committed', { teamId: operation.teamId })
      const ended = await stored(operation._id)

      await expect(service.retry(ended)).rejects.toMatchObject({
        output: { statusCode: 409 },
        data: { code: 'team-file-busy' }
      })
    })

    test('rethrows a failure to take the file that is not a clash', async () => {
      const operation = await seed('deploy-failed')
      await db
        .collection('operations')
        .updateOne({ _id: operation._id }, { $unset: { slot: '' } })
      const ended = await stored(operation._id)
      service = create({
        db: {
          collection(name) {
            const collection = db.collection(name)

            if (name === 'operations') {
              collection.findOneAndUpdate = async () => {
                throw new Error('mongo down')
              }
            }

            return collection
          }
        }
      })

      await expect(service.retry(ended)).rejects.toThrow('mongo down')
    })

    test('reads the operation again when taking the file is lost to another writer', async () => {
      const operation = await seed('deploy-failed')
      await db
        .collection('operations')
        .updateOne({ _id: operation._id }, { $unset: { slot: '' } })
      const ended = await stored(operation._id)
      service = create({ db: losing(1) })

      await service.retry(ended)

      expect((await stored(operation._id)).slot).toBe('active')
    })
  })
})
