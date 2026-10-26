import {
  createMockGitopsWorker,
  createMockRunReader,
  createMockTransport,
  mockOutcomeOfPurpose
} from '#/adapters/mock-gitops-worker.js'
import { validateEvent } from '#/contracts/message-validators.js'
import { exampleCommand } from '#/common/test-helpers/gitops-messages.js'
import { uuidv7 } from '#/common/helpers/uuid-v7.js'

const FORCED_CHECKS = 'entra:00000000-0000-0000-0001-000000000001'
const FORCED_DEPLOY = 'entra:00000000-0000-0000-0002-000000000001'

function dbHolding(operation) {
  return { collection: () => ({ findOne: async () => operation }) }
}

describe('mock-gitops-worker', () => {
  let events
  let runReader
  let handle
  let operationId

  function worker({ operation = null, now, handleEvent = handle } = {}) {
    return createMockGitopsWorker({
      db: dbHolding(operation),
      handle: handleEvent,
      runReader,
      stageDurationMs: 0,
      logger: { warn: vi.fn() },
      ...(now ? { now } : {})
    })
  }

  function command(overrides = {}) {
    return exampleCommand({ operationId, ...overrides })
  }

  function statuses() {
    return events.map(({ status }) => status)
  }

  beforeEach(() => {
    operationId = uuidv7()
    events = []
    runReader = createMockRunReader()
    handle = vi.fn(async (event) => {
      events.push(event)
    })
  })

  describe('mockOutcomeOfPurpose', () => {
    test.each([
      ['Journey test [mock:checks-failed]', 'checks-failed'],
      ['[mock:deploy-failed] on purpose', 'deploy-failed'],
      ['A purpose with no marker', null],
      ['[mock:something-else]', null],
      [undefined, null]
    ])('reads %j as %j', (purpose, outcome) => {
      expect(mockOutcomeOfPurpose(purpose)).toBe(outcome)
    })
  })

  describe('a submit command', () => {
    test('sends requested, committed, deploying and deployed, each a valid event', async () => {
      const mock = worker()

      await mock.accept(command())
      await mock.idle()

      expect(statuses()).toEqual([
        'requested',
        'committed',
        'deploying',
        'deployed'
      ])

      for (const event of events) {
        expect(validateEvent(event)).toEqual({ valid: true, errors: [] })
      }
    })

    test('carries the command identity, the commit and the apply facts', async () => {
      const mock = worker()

      await mock.accept(command({ traceparent: null, cdpRequestId: null }))
      await mock.idle()

      const [requested, committed, deploying, deployed] = events

      expect(requested).toMatchObject({
        operationId,
        environment: 'infradev',
        team: 'alpha',
        path: 'environments/infradev/alpha.json',
        action: 'write',
        source: 'submit',
        traceparent: null,
        cdpRequestId: null
      })
      expect(committed.commitSha).toMatch(/^[0-9a-f]{40}$/)
      expect(deploying).toMatchObject({
        source: 'apply',
        commitSha: committed.commitSha,
        committedAt: committed.committedAt
      })
      expect(deployed).toMatchObject({
        appliedSha: committed.commitSha,
        resources: []
      })
      expect(deploying.runId).toBeGreaterThan(committed.runId)
      expect(requested.runId).toBe(committed.runId)
      expect(deployed.eventId).toBe(
        `${operationId}:deployed:${deployed.runId}:1`
      )
    })

    test('gives every command runs later than the last', async () => {
      const mock = worker({ now: () => 5 })

      await mock.accept(command())
      await mock.accept(command({ operationId: uuidv7() }))
      await mock.idle()

      const runIds = events.map(({ runId }) => runId)

      expect(new Set(runIds).size).toBe(4)
      expect(Math.min(...runIds)).toBeGreaterThanOrEqual(5)
    })

    test('records the runs, so a failure can be corroborated', async () => {
      const mock = worker({ operation: { mockOutcome: 'deploy-failed' } })

      await mock.accept(command())
      await mock.idle()

      const failed = events.at(-1)
      const run = await runReader.getRun({ runId: failed.runId })

      expect(run).toMatchObject({
        headBranch: 'main',
        path: '.github/workflows/apply.yml',
        status: 'completed',
        conclusion: 'failure'
      })
      expect(await runReader.getRunReport({ runId: failed.runId })).toEqual({
        outcome: 'failure',
        failingTeams: ['alpha']
      })

      const submitted = await runReader.getRun({ runId: events[0].runId })

      expect(submitted.path).toBe('.github/workflows/submit.yml')
      expect(submitted.name).toContain(`(${operationId})`)
      expect(
        await runReader.getRunReport({ runId: events[0].runId })
      ).toBeNull()
    })

    test('takes the action from the command, or the operation when the command has none', async () => {
      const mock = worker({ operation: { action: 'remove' } })

      await mock.accept(command({ action: 'revert' }))
      await mock.idle()

      expect(events[0].action).toBe('revert')

      events.length = 0
      await mock.accept(command({ type: 'apply', action: undefined }))
      await mock.idle()

      expect(events[0].action).toBe('remove')
    })
  })

  describe('forced outcomes', () => {
    test('a requester in the checks-failed range ends at checks-failed, with no commit', async () => {
      const mock = worker()

      await mock.accept(command({ requestedBy: FORCED_CHECKS }))
      await mock.idle()

      expect(statuses()).toEqual(['requested', 'checks-failed'])
      expect(events[1]).toMatchObject({
        source: 'submit',
        failureReason: { retryable: false }
      })
      expect(validateEvent(events[1]).valid).toBe(true)
      expect(
        (await runReader.getRun({ runId: events[1].runId })).conclusion
      ).toBe('failure')
    })

    test('a requester in the deploy-failed range ends at an unattributable deploy-failed', async () => {
      const mock = worker()

      await mock.accept(command({ requestedBy: FORCED_DEPLOY }))
      await mock.idle()

      expect(statuses()).toEqual([
        'requested',
        'committed',
        'deploying',
        'deploy-failed'
      ])
      expect(events.at(-1)).toMatchObject({
        attributable: false,
        failingTeams: ['alpha'],
        failureReason: { retryable: false }
      })
      expect(validateEvent(events.at(-1)).valid).toBe(true)
    })

    test.each([
      ['checks-failed', ['requested', 'checks-failed']],
      [
        'deploy-failed',
        ['requested', 'committed', 'deploying', 'deploy-failed']
      ]
    ])(
      'an operation recording %s (the purpose marker) forces it',
      async (mockOutcome, expected) => {
        const mock = worker({ operation: { mockOutcome } })

        await mock.accept(command())
        await mock.idle()

        expect(statuses()).toEqual(expected)
      }
    )

    test('an apply of the second attempt goes through, so an admin retry can succeed', async () => {
      const mock = worker({ operation: { mockOutcome: 'deploy-failed' } })

      await mock.accept(command({ type: 'apply', attempt: 2 }))
      await mock.idle()

      expect(statuses()).toEqual(['deploying', 'deployed'])
    })
  })

  describe('apply and reconcile commands', () => {
    test('an apply sends deploying and deployed from the operation commit', async () => {
      const mock = worker({
        operation: {
          gitops: {
            commitSha: 'a'.repeat(40),
            committedAt: '2026-10-26T12:00:24Z'
          }
        }
      })

      await mock.accept(command({ type: 'apply' }))
      await mock.idle()

      expect(statuses()).toEqual(['deploying', 'deployed'])
      expect(events[0]).toMatchObject({
        commitSha: 'a'.repeat(40),
        committedAt: '2026-10-26T12:00:24Z'
      })
      expect(validateEvent(events[1]).valid).toBe(true)
    })

    test('a reconcile from requested sends the whole sequence', async () => {
      const mock = worker()

      await mock.accept(command({ type: 'reconcile', state: 'requested' }))
      await mock.idle()

      expect(statuses()).toEqual([
        'requested',
        'committed',
        'deploying',
        'deployed'
      ])
    })

    test.each(['committed', 'deploying', 'deployed'])(
      'a reconcile from %s sends the apply',
      async (state) => {
        const mock = worker()

        await mock.accept(command({ type: 'reconcile', state }))
        await mock.idle()

        expect(statuses()).toEqual(['deploying', 'deployed'])
      }
    )

    test.each(['queued', 'active', 'timed-out'])(
      'a reconcile from %s sends nothing',
      async (state) => {
        const mock = worker()

        await mock.accept(command({ type: 'reconcile', state }))
        await mock.idle()

        expect(events).toEqual([])
      }
    )
  })

  describe('failures and stopping', () => {
    test('logs an event the handler cannot take and sends no more of that command', async () => {
      const logger = { warn: vi.fn() }
      const mock = createMockGitopsWorker({
        db: dbHolding(null),
        handle: vi.fn().mockRejectedValue(new Error('handler down')),
        runReader,
        stageDurationMs: 0,
        logger
      })

      await mock.accept(command())
      await mock.idle()

      expect(logger.warn).toHaveBeenCalledWith(
        { operationId, message: 'handler down' },
        'The mock worker could not send an event'
      )
    })

    test('stop cancels the events still to come', async () => {
      const mock = createMockGitopsWorker({
        db: dbHolding(null),
        handle,
        runReader,
        stageDurationMs: 60000
      })

      await mock.accept(command())
      mock.stop()
      await mock.idle()

      expect(events).toEqual([])
    })
  })

  describe('the transport', () => {
    test('feeds a published command to the handler and stops cleanly', async () => {
      const transport = createMockTransport(
        { db: dbHolding(null), handle },
        { stageDurationMs: 0 }
      )

      transport.start()
      await transport.publisher.publish(command())
      await transport.worker.idle()
      await transport.stop()

      expect(statuses()).toEqual([
        'requested',
        'committed',
        'deploying',
        'deployed'
      ])
      expect(transport.runReader.getRun).toEqual(expect.any(Function))
    })

    test('takes the stage duration from the configuration by default', async () => {
      const transport = createMockTransport({ db: dbHolding(null), handle })

      expect(transport.publisher.publish).toEqual(expect.any(Function))
      await transport.stop()
    })
  })

  test('the run reader knows the main branch, no actor permissions and no run it did not record', async () => {
    expect(await runReader.isOnMain()).toBe(true)
    expect(await runReader.getActorPermission()).toBeNull()
    expect(await runReader.getRun({ runId: 1 })).toBeNull()
    expect(await runReader.getRunReport({ runId: 1 })).toBeNull()
  })
})
