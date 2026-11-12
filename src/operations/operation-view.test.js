import { STEP_KEYS, toOperationView } from '#/operations/operation-view.js'
import { FAILURE_CODES } from '#/operations/operation-projection.js'

const T = (minute) => `2026-11-12T10:${String(minute).padStart(2, '0')}:00.000Z`
const ADD = { entryId: 'e1', modelSlug: 'gpt-4o', change: 'add' }
const REMOVE = { entryId: 'e1', modelSlug: 'gpt-4o', change: 'remove' }
const LIMITS = { tokensPerMinute: 2000, requestsPerMinute: 30 }
const LIMITS_ITEM = { kind: 'limits', change: 'set', limits: LIMITS }

// An operation that went through `states`, one minute apart from minute 0.
function operationThrough(states, overrides = {}) {
  const history = states.map((state, index) => ({
    state,
    at: T(index),
    source: 'backend'
  }))

  return {
    _id: '0193a000-0000-7000-8000-0000000abcde',
    type: 'team-file.write',
    teamId: 'team-1',
    environment: 'infradev',
    state: states.at(-1),
    items: [ADD],
    history,
    gitops: {},
    attempt: 1,
    createdAt: T(0),
    updatedAt: T(states.length - 1),
    requestedByUserId: 'user-1',
    slot: 'active',
    ...overrides
  }
}

function statusesOf(view) {
  return view.steps.map(({ status }) => status)
}

describe('toOperationView', () => {
  test('names the operation, its environment, state and times, and who asked', () => {
    const view = toOperationView(operationThrough(['requested']), {
      requesterName: 'Amelia Shaw'
    })

    expect(view).toMatchObject({
      id: '0193a000-0000-7000-8000-0000000abcde',
      environment: 'infradev',
      kind: 'model',
      state: 'requested',
      requestedBy: { name: 'Amelia Shaw' },
      createdAt: T(0),
      updatedAt: T(0),
      failureReason: null,
      runUrl: null,
      supportReference: 'AIP-ABCDE',
      open: true
    })
  })

  test('has no requester name for a change the platform made itself or a person who has left', () => {
    expect(
      toOperationView(operationThrough(['requested'])).requestedBy
    ).toBeNull()
  })

  test('shows the five steps with the time each was reached', () => {
    const view = toOperationView(
      operationThrough(['requested', 'committed', 'deploying', 'deployed'])
    )

    expect(view.steps.map(({ key }) => key)).toEqual(STEP_KEYS)
    expect(view.steps.map(({ label }) => label)).toEqual([
      'Request received',
      'Checks passed',
      'Deploying',
      'Deployed',
      'Ready to use'
    ])
    expect(statusesOf(view)).toEqual([
      'done',
      'done',
      'done',
      'current',
      'todo'
    ])
    expect(view.steps.map(({ at }) => at)).toEqual([
      T(0),
      T(1),
      T(2),
      T(3),
      null
    ])
  })

  test.each([
    ['queued', ['queued'], ['current', 'todo', 'todo', 'todo', 'todo']],
    ['requested', ['requested'], ['current', 'todo', 'todo', 'todo', 'todo']],
    [
      'committed',
      ['requested', 'committed'],
      ['done', 'current', 'todo', 'todo', 'todo']
    ],
    [
      'verified',
      ['requested', 'committed', 'deploying', 'deployed', 'verified'],
      ['done', 'done', 'done', 'done', 'current']
    ],
    [
      'active',
      ['requested', 'committed', 'deploying', 'deployed', 'verified', 'active'],
      ['done', 'done', 'done', 'done', 'done']
    ],
    [
      'removed',
      ['requested', 'committed', 'deploying', 'deployed', 'removed'],
      ['done', 'done', 'done', 'done', 'done']
    ]
  ])(
    'marks the steps of an operation in the state %s',
    (_name, states, expected) => {
      const view = toOperationView(
        operationThrough(states, { slot: undefined })
      )

      expect(statusesOf(view)).toEqual(expected)
    }
  )

  test('a step the operation went past without an event reads as reached at the next one', () => {
    const view = toOperationView(
      operationThrough(['requested', 'deployed', 'active'], { slot: undefined })
    )

    expect(view.steps.map(({ at }) => at)).toEqual([
      T(0),
      T(1),
      T(1),
      T(1),
      T(2)
    ])
  })

  describe('a change that failed its checks', () => {
    const failed = operationThrough(['requested', 'checks-failed'], {
      slot: undefined,
      error: {
        code: FAILURE_CODES.CHECKS_FAILED,
        message: 'The team file is not valid',
        retryable: false
      },
      gitops: { submitRunUrl: 'https://github.com/DEFRA/x/actions/runs/1' }
    })

    test('fails the checks step with the reason, the run and the support reference', () => {
      const view = toOperationView(failed)

      expect(statusesOf(view)).toEqual([
        'done',
        'failed',
        'todo',
        'todo',
        'todo'
      ])
      expect(view.steps[1].at).toBe(T(1))
      expect(view).toMatchObject({
        state: 'checks-failed',
        failureReason: 'The team file is not valid',
        runUrl: 'https://github.com/DEFRA/x/actions/runs/1',
        supportReference: 'AIP-ABCDE',
        open: false
      })
    })
  })

  describe('a deployment that failed', () => {
    const states = ['requested', 'committed', 'deploying', 'deploy-failed']

    test('fails the deploying step and prefers the apply run', () => {
      const view = toOperationView(
        operationThrough(states, {
          slot: undefined,
          error: { code: FAILURE_CODES.DEPLOY_FAILED, retryable: false },
          gitops: {
            submitRunUrl: 'https://github.com/DEFRA/x/actions/runs/1',
            applyRunUrl: 'https://github.com/DEFRA/x/actions/runs/2'
          }
        })
      )

      expect(statusesOf(view)).toEqual([
        'done',
        'done',
        'failed',
        'todo',
        'todo'
      ])
      expect(view.steps[2].at).toBe(T(3))
      expect(view.failureReason).toBe('The deployment failed')
      expect(view.runUrl).toBe('https://github.com/DEFRA/x/actions/runs/2')
    })

    test('fails the deployed step when the resources could not be confirmed', () => {
      const view = toOperationView(
        operationThrough(
          ['requested', 'committed', 'deploying', 'deployed', 'deploy-failed'],
          {
            slot: undefined,
            error: {
              code: FAILURE_CODES.VERIFY_FAILED,
              message: 'resource-not-succeeded'
            }
          }
        )
      )

      expect(statusesOf(view)).toEqual([
        'done',
        'done',
        'done',
        'failed',
        'todo'
      ])
      expect(view.failureReason).toMatch(/could not be confirmed/)
    })

    test('says so when the revert failed too', () => {
      const view = toOperationView(
        operationThrough(states, {
          revertFailed: true,
          error: { code: FAILURE_CODES.DEPLOY_FAILED }
        })
      )

      expect(view.failureReason).toMatch(/reverting the change failed too/)
      expect(view.open).toBe(true)
    })
  })

  describe('a removal', () => {
    test('that failed says the model is still deployed and quotes the reference', () => {
      const view = toOperationView(
        operationThrough(['requested', 'deploy-failed'], {
          type: 'team-file.remove',
          items: [REMOVE],
          slot: undefined,
          error: { code: FAILURE_CODES.DEPLOY_FAILED }
        })
      )

      expect(view.failureReason).toMatch(/still deployed.*AIP-ABCDE/)
      expect(view.changes).toEqual([
        { kind: 'model', change: 'remove', modelSlug: 'gpt-4o' }
      ])
    })
  })

  describe('an operation that timed out', () => {
    test.each([
      ['requested', 1],
      ['committed', 2],
      ['deploying', 3],
      ['deployed', 4]
    ])('fails the step after %s, the one it was waiting for', (left, index) => {
      const states = ['requested', 'committed', 'deploying', 'deployed']
      const reached = states.slice(0, states.indexOf(left) + 1)
      const view = toOperationView(
        operationThrough([...reached, 'timed-out'], {
          leftState: left,
          slot: undefined,
          error: { code: FAILURE_CODES.TIMED_OUT }
        })
      )

      expect(view.steps.findIndex(({ status }) => status === 'failed')).toBe(
        index
      )
      expect(view.failureReason).toBe('The setup did not finish in time')
      expect(view.state).toBe('timed-out')
    })
  })

  describe('kind and changes', () => {
    test('reads items with no kind as models, so an operation from before limits changes keeps working', () => {
      const view = toOperationView(operationThrough(['requested']))

      expect(view.kind).toBe('model')
      expect(view.changes).toEqual([
        { kind: 'model', change: 'add', modelSlug: 'gpt-4o' }
      ])
    })

    test('names a limits change with the limits it asks for', () => {
      const view = toOperationView(
        operationThrough(['requested'], { items: [LIMITS_ITEM] })
      )

      expect(view.kind).toBe('limits')
      expect(view.changes).toEqual([
        { kind: 'limits', change: 'set', limits: LIMITS }
      ])
    })

    test('is mixed when a waiting operation merged a model and a limits change', () => {
      const view = toOperationView(
        operationThrough(['queued'], { items: [ADD, LIMITS_ITEM] })
      )

      expect(view.kind).toBe('mixed')
      expect(view.changes).toHaveLength(2)
    })

    test('is a revert for the platform undoing a failed change', () => {
      const view = toOperationView(
        operationThrough(['requested'], { type: 'team-file.revert' })
      )

      expect(view.kind).toBe('revert')
    })

    test('keeps the kind of a federation item without knowing its payload', () => {
      const view = toOperationView(
        operationThrough(['requested'], {
          items: [{ kind: 'federation', entryId: 'f1', change: 'add' }]
        })
      )

      expect(view.kind).toBe('federation')
      expect(view.changes).toEqual([{ kind: 'federation', change: 'add' }])
    })
  })

  test('holds no personal data beyond the requester name, and never the document or the outbox', () => {
    const view = toOperationView(
      operationThrough(['requested'], {
        document: '{"secret":true}',
        outbox: [{ commandId: 'c1' }],
        requestedBy: 'entra:00000000-0000-0000-0000-000000000001',
        traceparent: '00-abc'
      }),
      { requesterName: 'Amelia Shaw' }
    )
    const text = JSON.stringify(view)

    expect(text).not.toMatch(/secret|commandId|entra:|traceparent|user-1/)
  })

  test('an operation with no history still shows its first step at creation', () => {
    const view = toOperationView({
      ...operationThrough(['requested']),
      history: undefined
    })

    expect(view.steps[0]).toMatchObject({ status: 'current', at: T(0) })
  })

  test('a failed operation with an empty history has no time for its failed step', () => {
    const view = toOperationView(
      operationThrough(['checks-failed'], { history: [] })
    )

    expect(view.steps[1]).toMatchObject({ status: 'failed', at: null })
  })

  test('a timed-out operation that does not say where it was waiting for fails the checks', () => {
    const view = toOperationView(
      operationThrough(['requested', 'timed-out'], { leftState: undefined })
    )

    expect(statusesOf(view)).toEqual(['done', 'failed', 'todo', 'todo', 'todo'])
  })

  test('an operation holding no items is a model change with no changes', () => {
    const none = toOperationView(operationThrough(['requested'], { items: [] }))
    const absent = toOperationView(
      operationThrough(['requested'], { items: undefined })
    )

    expect(none).toMatchObject({ kind: 'model', changes: [] })
    expect(absent).toMatchObject({ kind: 'model', changes: [] })
    expect(absent.failureReason).toBeNull()
  })
})
