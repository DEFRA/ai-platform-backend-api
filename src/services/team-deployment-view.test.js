import {
  buildProgressSteps,
  toDeploymentView
} from '#/services/team-deployment-view.js'
import { entryFieldsOf } from '#/operations/operation-projection.js'

const doc = { teamId: 'team-1', environment: 'infradev' }

function entry(fields) {
  return { id: 'entry-1', modelSlug: 'gpt-4o', status: 'active', ...fields }
}

describe('buildProgressSteps', () => {
  const labels = [
    'Request recorded',
    'Change committed',
    'Setting up GPT-4o in Azure',
    'Checking your resources in Azure',
    'Preparing your client secret'
  ]
  const T0 = '2026-10-21T10:40:00.000Z'
  const T1 = '2026-10-21T10:41:00.000Z'
  const T2 = '2026-10-21T10:42:00.000Z'
  const T3 = '2026-10-21T10:43:00.000Z'
  const T4 = '2026-10-21T10:44:00.000Z'
  const T5 = '2026-10-21T10:45:00.000Z'
  const T6 = '2026-10-21T10:50:00.000Z'
  const statusTimes = {
    requested: T0,
    committed: T1,
    deploying: T2,
    deployed: T3,
    verified: T4,
    active: T5
  }

  // `at` is when a done step finished, when the current one started, and
  // null for one not reached.
  test.each([
    ['queued', ['current', 'pending', 'pending', 'pending', 'pending'], [T0]],
    [
      'requested',
      ['current', 'pending', 'pending', 'pending', 'pending'],
      [T0]
    ],
    [
      'committed',
      ['done', 'current', 'pending', 'pending', 'pending'],
      [T1, T1]
    ],
    [
      'deploying',
      ['done', 'done', 'current', 'pending', 'pending'],
      [T1, T2, T2]
    ],
    [
      'deployed',
      ['done', 'done', 'done', 'current', 'pending'],
      [T1, T2, T3, T3]
    ],
    [
      'verified',
      ['done', 'done', 'done', 'done', 'current'],
      [T1, T2, T3, T4, T4]
    ],
    ['active', ['done', 'done', 'done', 'done', 'done'], [T1, T2, T3, T4, T5]]
  ])('marks the steps and times for %s', (status, states, times) => {
    const steps = buildProgressSteps({ status, statusTimes }, 'GPT-4o')

    expect(steps.map(({ label }) => label)).toEqual(labels)
    expect(steps.map(({ state }) => state)).toEqual(states)
    expect(steps.map(({ at }) => at)).toEqual(
      [...times, null, null, null, null, null].slice(0, 5)
    )
  })

  test('reads a step the entry skipped as instant, starting when the next did', () => {
    const steps = buildProgressSteps(
      {
        status: 'deployed',
        statusTimes: { requested: T0, committed: T1, deployed: T3 }
      },
      'GPT-4o'
    )

    expect(steps.map(({ at }) => at)).toEqual([T1, T3, T3, T3, null])
  })

  test('keeps completed steps in order across a retry that records deploying after deployed', () => {
    const seen = { requested: T0, deployed: T4 }
    const ats = (status, times) =>
      buildProgressSteps({ status, statusTimes: times }, 'GPT-4o').map(
        ({ at }) => at
      )

    const before = ats('deployed', seen)

    expect(before).toEqual([T4, T4, T4, T4, null])
    // The retry resumes at deploying, later.
    expect(ats('deploying', { ...seen, deploying: T6 })).toEqual([
      T4,
      T4,
      T4,
      null,
      null
    ])
    expect(ats('deployed', { ...seen, deploying: T6 })).toEqual(before)
  })

  test('falls back to when the entry was created and activated for one from before times were recorded', () => {
    const active = buildProgressSteps(
      { status: 'active', createdAt: T0, activatedAt: T4 },
      'GPT-4o'
    )
    const requested = buildProgressSteps(
      { status: 'requested', createdAt: T0 },
      'GPT-4o'
    )

    expect(active.map(({ at }) => at)).toEqual([T4, T4, T4, T4, T4])
    expect(requested.map(({ at }) => at)).toEqual([T0, null, null, null, null])
  })

  test.each([
    'checks-failed',
    'deploy-failed',
    'timed-out',
    'removing',
    'removed'
  ])('has no steps for %s', (status) => {
    expect(buildProgressSteps({ status }, 'GPT-4o')).toBeNull()
  })
})

describe('toDeploymentView', () => {
  test('names the model by its display name in the step label, the slug when there is none', () => {
    const named = toDeploymentView(
      doc,
      entry({ status: 'requested' }),
      undefined,
      'GPT-4o'
    )
    const unnamed = toDeploymentView(doc, entry({ status: 'requested' }))

    expect(named.progressSteps[2].label).toBe('Setting up GPT-4o in Azure')
    expect(unnamed.progressSteps[2].label).toBe('Setting up gpt-4o in Azure')
  })

  test('shows what the projection wrote: the operation, links, resources and registration', () => {
    const operation = {
      id: 'op-1',
      state: 'deployed',
      attempt: 1,
      runUrl: 'https://github.com/DEFRA/ai-platform-tenants/actions/runs/2',
      commitSha: 'a'.repeat(40),
      failureReason: null
    }
    const links = {
      submitRun: 'https://github.com/DEFRA/ai-platform-tenants/actions/runs/1',
      applyRun: operation.runUrl
    }
    const resources = [
      { name: 'aip-alpha', kind: 'Foundry project', verified: false }
    ]
    const view = toDeploymentView(
      doc,
      entry({
        status: 'deployed',
        operationId: 'op-1',
        operation,
        links,
        resources,
        appRegistration: 'skipped',
        verificationFailure: { reason: 'resource-unavailable', attempts: 2 }
      })
    )

    expect(view).toMatchObject({
      operationId: 'op-1',
      operation,
      links,
      resources,
      appRegistration: 'skipped',
      verificationFailure: { reason: 'resource-unavailable', attempts: 2 }
    })
    expect(view.links).not.toHaveProperty('pullRequest')
  })

  test('shows the operation of an entry written by the projection', () => {
    const operation = {
      _id: 'op-2',
      state: 'committed',
      stateVersion: 3,
      attempt: 1,
      gitops: {
        submitRunUrl:
          'https://github.com/DEFRA/ai-platform-tenants/actions/runs/7',
        commitSha: 'b'.repeat(40)
      }
    }
    const stored = {
      ...entry({ status: 'requested' }),
      ...entryFieldsOf(operation, { change: 'add' }, {}, '2026-10-26T12:00:00Z')
    }
    const view = toDeploymentView(doc, stored)

    expect(view.status).toBe('committed')
    expect(view.operation).toEqual({
      id: 'op-2',
      state: 'committed',
      attempt: 1,
      runUrl: 'https://github.com/DEFRA/ai-platform-tenants/actions/runs/7',
      commitSha: 'b'.repeat(40),
      failureReason: null
    })
    expect(view.links).toEqual({
      submitRun: 'https://github.com/DEFRA/ai-platform-tenants/actions/runs/7'
    })
  })

  test('has no operation, links, resources or registration for an entry the projection has not reached', () => {
    const view = toDeploymentView(doc, entry({ status: 'queued' }))

    expect(view).toMatchObject({
      operation: null,
      links: {},
      resources: [],
      appRegistration: null,
      verificationFailure: null,
      removedAt: null
    })
  })

  describe('credentialPlaceholder', () => {
    test.each([
      [true, 'is set while the team client secret is mocked'],
      [false, 'is not set once the team client secret is real']
    ])('%s: %s', (mocked, _name) => {
      const registry = { isMockedFor: (tier) => mocked && tier === 'team' }

      expect(
        toDeploymentView(doc, entry(), registry).credentialPlaceholder
      ).toBe(mocked)
    })
  })
})
