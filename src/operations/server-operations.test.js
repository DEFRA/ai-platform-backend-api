import { LockManager } from 'mongo-locks'
import { MongoClient } from 'mongodb'

import { createMockTransport } from '#/adapters/mock-gitops-worker.js'
import { mockTeamFileReader } from '#/adapters/mock-team-file-reader.js'
import { exampleEvent, OID } from '#/common/test-helpers/gitops-messages.js'
import { gitopsSettings } from '#/operations/gitops-settings.js'
import {
  createOperationIndexes,
  findOperation
} from '#/operations/operation-repository.js'
import { createServerOperations } from '#/operations/server-operations.js'

const DATABASE = 'server-operations-test'
const TARGET = {
  repository: 'DEFRA/ai-platform-tenants',
  team: 'alpha',
  path: 'environments/infradev/alpha.json'
}
const ITEM = { entryId: 'entry-1', modelSlug: 'gpt-4o', change: 'add' }

describe('server-operations', () => {
  const settings = gitopsSettings({
    environments: ['infradev'],
    outboxSweepMs: 20,
    sweepIntervalMs: 20
  })
  let client
  let db
  let locker
  let logger
  let transport
  let registry
  let ops
  let teams = 0

  function requestParams(overrides = {}) {
    teams += 1

    return {
      teamId: `team-${teams}`,
      environment: 'infradev',
      target: TARGET,
      items: [ITEM],
      requestedBy: `entra:${OID}`,
      requestedByUserId: 'user-1',
      idempotencyKey: `key-${teams}`,
      ...overrides
    }
  }

  function build(overrides = {}) {
    return createServerOperations({
      db,
      locker,
      logger,
      registry,
      settings,
      ...overrides,
      verifier: { verify: vi.fn().mockResolvedValue({ verified: true }) },
      buildDocument: vi.fn().mockResolvedValue({
        document: { environment: 'infradev', revision: 1 },
        expectedRevision: 0
      }),
      grantCredentials: vi.fn().mockResolvedValue(undefined)
    })
  }

  async function ended(operationId) {
    await transport.worker.idle()

    return findOperation(db, operationId)
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
      'teamDeployments',
      'auditEvents',
      'mongo-locks'
    ]) {
      await db.collection(name).deleteMany({})
    }

    logger = { warn: vi.fn(), error: vi.fn() }
    registry = {
      key: 'mock',
      reader: mockTeamFileReader,
      createTransport: vi.fn((deps) => {
        transport = createMockTransport(deps, { stageDurationMs: 0 })

        return transport
      })
    }
    ops = build()
  })

  afterEach(async () => {
    await ops.stop()
  })

  test('wires the runtime over the registry transport and its reader', () => {
    expect(registry.createTransport).toHaveBeenCalledWith({
      db,
      logger,
      handle: expect.any(Function)
    })
    expect(ops.transport).toBe(transport)
    expect(Object.keys(ops).sort()).toEqual([
      'controls',
      'external',
      'handler',
      'operations',
      'relay',
      'start',
      'stop',
      'sweeper',
      'transport',
      'verifier'
    ])
  })

  test('hands the transport the events handler', async () => {
    const { handle } = registry.createTransport.mock.calls[0][0]

    expect(
      await handle(exampleEvent('requested', { environment: 'sandbox' }))
    ).toEqual({ outcome: 'dropped', reason: 'unknown-environment' })
  })

  describe('with the mock transport', () => {
    test('takes a request through to active, with every stage in its history', async () => {
      const { operation } = await ops.operations.request(requestParams())

      const done = await ended(operation._id)

      expect(done.state).toBe('active')
      expect(done.history.map(({ state }) => state)).toEqual([
        'requested',
        'committed',
        'deploying',
        'deployed',
        'verified',
        'active'
      ])
    })

    test('a request whose purpose forces checks-failed ends there and frees the file', async () => {
      const params = requestParams({ mockOutcome: 'checks-failed' })
      const { operation } = await ops.operations.request(params)

      const done = await ended(operation._id)

      expect(done).toMatchObject({
        state: 'checks-failed',
        error: { code: 'operation-checks-failed' }
      })
      expect(done.slot).toBeUndefined()
    })

    test('a requester in the reserved range forces deploy-failed, final at once', async () => {
      const params = requestParams({
        requestedBy: 'entra:00000000-0000-0000-0002-000000000009'
      })
      const { operation } = await ops.operations.request(params)

      const done = await ended(operation._id)

      expect(done).toMatchObject({
        state: 'deploy-failed',
        error: { code: 'operation-deploy-failed' }
      })
      expect(done.slot).toBeUndefined()
    })
  })

  describe('the sweeps', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    test('start runs the outbox sweep and the deadline sweep, and starts the transport', async () => {
      vi.useFakeTimers()
      vi.spyOn(ops.relay, 'sweep').mockResolvedValue(0)
      vi.spyOn(ops.sweeper, 'sweep').mockResolvedValue({})
      vi.spyOn(transport, 'start')

      ops.start()
      await vi.advanceTimersByTimeAsync(45)

      expect(ops.relay.sweep).toHaveBeenCalledTimes(2)
      expect(ops.sweeper.sweep).toHaveBeenCalledTimes(2)
      expect(transport.start).toHaveBeenCalledTimes(1)
    })

    test('stop ends the sweeps and stops the transport', async () => {
      vi.useFakeTimers()
      vi.spyOn(ops.relay, 'sweep').mockResolvedValue(0)
      vi.spyOn(transport, 'stop')

      ops.start()
      await ops.stop()
      await vi.advanceTimersByTimeAsync(100)

      expect(ops.relay.sweep).not.toHaveBeenCalled()
      expect(transport.stop).toHaveBeenCalledTimes(1)
    })

    test('stop waits for a sweep that is already running before it stops the transport', async () => {
      vi.useFakeTimers()

      let release
      vi.spyOn(ops.relay, 'sweep').mockImplementation(
        () => new Promise((resolve) => (release = resolve))
      )
      vi.spyOn(transport, 'stop')

      ops.start()
      await vi.advanceTimersByTimeAsync(25)

      let stopped = false
      const stopping = ops.stop().then(() => {
        stopped = true
      })

      await vi.advanceTimersByTimeAsync(1000)

      expect(stopped).toBe(false)
      expect(transport.stop).not.toHaveBeenCalled()

      release(0)
      await stopping

      expect(stopped).toBe(true)
      expect(transport.stop).toHaveBeenCalledTimes(1)
    })

    test('stop does not wait past its bound for a sweep that never finishes', async () => {
      vi.useFakeTimers()
      ops = build({ drainTimeoutMs: 50 })
      vi.spyOn(ops.relay, 'sweep').mockImplementation(
        () => new Promise(() => {})
      )
      vi.spyOn(transport, 'stop')

      ops.start()
      await vi.advanceTimersByTimeAsync(25)

      let stopped = false
      const stopping = ops.stop().then(() => {
        stopped = true
      })

      await vi.advanceTimersByTimeAsync(49)

      expect(stopped).toBe(false)

      await vi.advanceTimersByTimeAsync(2)
      await stopping

      expect(stopped).toBe(true)
      expect(transport.stop).toHaveBeenCalledTimes(1)
    })

    test('a sweep that fails is logged and tried again, without its message being lost to the server', async () => {
      vi.useFakeTimers()
      vi.spyOn(ops.relay, 'sweep')
        .mockRejectedValueOnce(new Error('mongo down'))
        .mockResolvedValue(0)

      ops.start()
      await vi.advanceTimersByTimeAsync(45)

      expect(logger.error).toHaveBeenCalledWith(
        { message: 'mongo down' },
        'The outbox sweep failed'
      )
      expect(ops.relay.sweep).toHaveBeenCalledTimes(2)
    })

    test('a sweep never overlaps itself', async () => {
      vi.useFakeTimers()

      let release
      vi.spyOn(ops.relay, 'sweep').mockImplementation(
        () => new Promise((resolve) => (release = resolve))
      )

      ops.start()
      await vi.advanceTimersByTimeAsync(100)

      expect(ops.relay.sweep).toHaveBeenCalledTimes(1)

      release(0)
      await vi.advanceTimersByTimeAsync(25)

      expect(ops.relay.sweep).toHaveBeenCalledTimes(2)
    })
  })

  test('takes its settings from the configuration when none are given', () => {
    const configured = createServerOperations({
      db,
      locker,
      logger,
      registry,
      verifier: { verify: vi.fn() },
      buildDocument: vi.fn(),
      grantCredentials: vi.fn()
    })

    expect(configured.operations.request).toEqual(expect.any(Function))
  })
})
