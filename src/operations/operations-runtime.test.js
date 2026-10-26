import { LockManager } from 'mongo-locks'
import { MongoClient } from 'mongodb'

import { createInMemoryCommandPublisher } from '#/adapters/in-memory-command-publisher.js'
import { mockTeamFileReader } from '#/adapters/mock-team-file-reader.js'
import { validateCommand } from '#/contracts/message-validators.js'
import { exampleEvent, OID } from '#/common/test-helpers/gitops-messages.js'
import { gitopsSettings } from '#/operations/gitops-settings.js'
import { createOperationIndexes } from '#/operations/operation-repository.js'
import { findOperation } from '#/operations/operation-repository.js'
import { createOperationsRuntime } from '#/operations/operations-runtime.js'

const DATABASE = 'operations-runtime-test'
const TARGET = {
  repository: 'DEFRA/ai-platform-tenants',
  team: 'alpha',
  path: 'environments/infradev/alpha.json'
}
const ITEM = { entryId: 'entry-1', modelSlug: 'gpt-4o', change: 'add' }

function run(overrides = {}) {
  return {
    headBranch: 'main',
    path: '.github/workflows/submit.yml',
    name: 'submit',
    status: 'completed',
    conclusion: 'failure',
    runStartedAt: '2026-10-26T12:00:00Z',
    actor: 'an-admin',
    triggeringActor: 'an-admin',
    ...overrides
  }
}

describe('operations-runtime', () => {
  const settings = gitopsSettings({
    environments: ['infradev'],
    deadlines: {
      requested: 600000,
      committed: 1800000,
      deploying: 2700000,
      deployed: 900000
    }
  })
  let client
  let db
  let locker
  let publisher
  let runReader
  let verifier
  let buildDocument
  let grantCredentials
  let runtime
  let teams = 0

  function build(overrides = {}) {
    return createOperationsRuntime({
      db,
      locker,
      logger: { warn: vi.fn(), error: vi.fn() },
      settings,
      publisher,
      reader: mockTeamFileReader,
      runReader,
      verifier,
      buildDocument,
      grantCredentials,
      ...overrides
    })
  }

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

  function event(operation, status, overrides = {}) {
    return exampleEvent(status, { operationId: operation._id, ...overrides })
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

    publisher = createInMemoryCommandPublisher()
    runReader = {
      getRun: vi.fn().mockResolvedValue(run()),
      getRunReport: vi.fn().mockResolvedValue(null),
      getActorPermission: vi.fn().mockResolvedValue('admin'),
      isOnMain: vi.fn().mockResolvedValue(true)
    }
    verifier = { verify: vi.fn().mockResolvedValue({ verified: true }) }
    buildDocument = vi.fn().mockResolvedValue({
      document: { environment: 'infradev', revision: 1 },
      expectedRevision: 0
    })
    grantCredentials = vi.fn().mockResolvedValue(undefined)
    runtime = build()
  })

  test('exposes the wired parts', () => {
    expect(Object.keys(runtime).sort()).toEqual([
      'controls',
      'external',
      'handler',
      'operations',
      'relay',
      'sweeper',
      'verifier'
    ])
    expect(runtime.handler.handle).toEqual(expect.any(Function))
    expect(runtime.sweeper.sweep).toEqual(expect.any(Function))
    expect(runtime.relay.publishOperation).toEqual(expect.any(Function))
    expect(runtime.operations.request).toEqual(expect.any(Function))
    expect(runtime.verifier.verify).toEqual(expect.any(Function))
    expect(runtime.controls.isPaused).toEqual(expect.any(Function))
    expect(runtime.external.record).toEqual(expect.any(Function))
  })

  test('takes its settings from the configuration when none are given', async () => {
    const configured = build({ settings: undefined })

    const result = await configured.handler.handle(
      exampleEvent('requested', { environment: 'infradev' })
    )

    expect(result).toEqual({
      outcome: 'dropped',
      reason: 'unknown-environment'
    })
  })

  describe('a request through to an active operation', () => {
    test('publishes a valid submit command, follows the events and ends active, granting the credential', async () => {
      const { operation } = await runtime.operations.request(requestParams())

      expect(publisher.published).toHaveLength(1)
      expect(validateCommand(publisher.published[0]).valid).toBe(true)
      expect(publisher.published[0]).toMatchObject({
        type: 'submit',
        operationId: operation._id,
        environment: 'infradev',
        team: 'alpha',
        action: 'write'
      })
      expect((await findOperation(db, operation._id)).outboxPending).toBe(false)

      await runtime.handler.handle(event(operation, 'requested'))
      await runtime.handler.handle(event(operation, 'committed'))
      await runtime.handler.handle(event(operation, 'deploying'))
      const result = await runtime.handler.handle(event(operation, 'deployed'))

      const ended = await findOperation(db, operation._id)

      expect(result.outcome).toBe('advance')
      expect(verifier.verify).toHaveBeenCalledWith({
        environment: 'infradev',
        resources: expect.any(Array)
      })
      expect(ended.state).toBe('active')
      expect(ended.slot).toBeUndefined()
      expect(grantCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ _id: operation._id })
      )
    })

    test('promotes the waiting request once the first ends', async () => {
      const first = requestParams()
      const { operation } = await runtime.operations.request(first)
      const second = await runtime.operations.request(
        requestParams({
          teamId: first.teamId,
          items: [{ ...ITEM, entryId: 'e2' }]
        })
      )

      expect(second.waiting).toBe(true)

      for (const status of ['committed', 'deploying', 'deployed']) {
        await runtime.handler.handle(event(operation, status))
      }

      expect(await findOperation(db, second.operation._id)).toMatchObject({
        slot: 'active',
        state: 'requested'
      })
      expect(publisher.published.map(({ type }) => type)).toEqual([
        'submit',
        'submit'
      ])
    })
  })

  describe('corroboration with the configured repositories', () => {
    test('accepts a refusal that GitHub bears out', async () => {
      const { operation } = await runtime.operations.request(requestParams())
      runReader.getRun.mockResolvedValue(
        run({ name: `Submit (${operation._id})` })
      )

      const result = await runtime.handler.handle(
        event(operation, 'checks-failed')
      )

      expect(result.outcome).toBe('advance')
      expect(runReader.getRun).toHaveBeenCalledWith({
        repository: TARGET.repository,
        runId: expect.any(Number)
      })
      expect((await findOperation(db, operation._id)).state).toBe(
        'checks-failed'
      )
    })

    test('drops a refusal from a repository that is not a state repository', async () => {
      const other = build({
        settings: gitopsSettings({
          ...settings,
          repositories: {
            tenants: 'ORG/other-tenants',
            deployments: 'ORG/other-deployments'
          }
        })
      })
      const { operation } = await other.operations.request(requestParams())

      const result = await other.handler.handle(
        event(operation, 'checks-failed')
      )

      expect(result).toEqual({
        outcome: 'dropped',
        reason: 'unknown-repository'
      })
      expect(runReader.getRun).not.toHaveBeenCalled()
      expect((await findOperation(db, operation._id)).state).toBe('requested')
    })
  })

  describe('pause', () => {
    function pause(status) {
      return exampleEvent(status, {
        action: 'pause',
        team: null,
        path: null,
        operationId: null
      })
    }

    test('holds a request made while paused and resubmits it on resume', async () => {
      runReader.getRun.mockResolvedValue(
        run({ path: '.github/workflows/pause.yml', conclusion: 'success' })
      )

      await runtime.handler.handle(pause('paused'))
      const { operation } = await runtime.operations.request(requestParams())

      expect(await runtime.controls.isPaused('infradev')).toBe(true)
      expect(await findOperation(db, operation._id)).toMatchObject({
        state: 'queued',
        held: { code: 'paused' }
      })
      expect(publisher.published).toHaveLength(0)

      runReader.getRun.mockResolvedValue(
        run({
          path: '.github/workflows/pause.yml',
          conclusion: 'success',
          runStartedAt: '2026-10-26T13:00:00Z'
        })
      )
      await runtime.handler.handle(pause('resumed'))

      expect(await runtime.controls.isPaused('infradev')).toBe(false)
      expect(await findOperation(db, operation._id)).toMatchObject({
        state: 'requested'
      })
      expect(publisher.published.map(({ type }) => type)).toEqual(['submit'])
    })

    test('ignores a pause by someone who is not an admin', async () => {
      runReader.getRun.mockResolvedValue(
        run({ path: '.github/workflows/pause.yml', conclusion: 'success' })
      )
      runReader.getActorPermission.mockResolvedValue('write')

      const result = await runtime.handler.handle(pause('paused'))

      expect(result).toEqual({ outcome: 'uncorroborated' })
      expect(await runtime.controls.isPaused('infradev')).toBe(false)
    })
  })

  describe('the sweeper and the relay', () => {
    test('reconciles an operation past its deadline through the relay', async () => {
      const { operation } = await runtime.operations.request(requestParams())
      await db
        .collection('operations')
        .updateOne(
          { _id: operation._id },
          { $set: { deadlineAt: new Date(Date.now() - 1000).toISOString() } }
        )

      const totals = await runtime.sweeper.sweep()

      expect(totals).toEqual({ overdue: 1, verified: 0, alarms: 0 })
      expect(publisher.published.map(({ type }) => type)).toEqual([
        'submit',
        'reconcile'
      ])
    })

    test('verifies a deployed operation whose retry is due', async () => {
      const { operation } = await runtime.operations.request(requestParams())

      for (const status of ['committed', 'deploying']) {
        await runtime.handler.handle(event(operation, status))
      }

      verifier.verify.mockResolvedValueOnce({
        verified: false,
        reason: 'resource-unavailable'
      })
      await runtime.handler.handle(event(operation, 'deployed'))

      expect((await findOperation(db, operation._id)).state).toBe('deployed')

      await db.collection('operations').updateOne(
        { _id: operation._id },
        {
          $set: {
            'verify.nextAt': new Date(Date.now() - 1000).toISOString(),
            deadlineAt: null
          }
        }
      )

      const totals = await runtime.sweeper.sweep()

      expect(totals.verified).toBe(1)
      expect((await findOperation(db, operation._id)).state).toBe('active')
      expect(grantCredentials).toHaveBeenCalledTimes(1)
    })
  })

  test('hands external runs to the external recorder', async () => {
    runReader.getRun.mockResolvedValue(
      run({ path: '.github/workflows/apply.yml' })
    )
    const message = exampleEvent('deploying', {
      action: 'apply',
      operationId: null,
      team: null,
      path: null
    })

    const result = await runtime.handler.handle(message)

    expect(result.outcome).toBe('recorded')
    expect(
      await db
        .collection('operations')
        .countDocuments({ externalKey: { $type: 'string' } })
    ).toBe(1)
  })
})
