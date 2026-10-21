import {
  buildProgressSteps,
  toDeploymentView
} from '#/services/team-deployment-view.js'

const doc = { teamId: 'team-1', environment: 'infradev' }

const resources = {
  project: {
    id: '/subscriptions/sub-secret/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/aif/projects/aip-alpha',
    name: 'aip-alpha'
  },
  deployments: {
    'gpt-4o': {
      id: '/subscriptions/sub-secret/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/aif/deployments/alpha-gpt-4o',
      name: 'alpha-gpt-4o'
    }
  },
  api: { id: '/subscriptions/sub-secret/x', name: 'alpha', path: 'alpha' },
  registration: null
}

function entry(fields) {
  return { id: 'entry-1', modelSlug: 'gpt-4o', status: 'active', ...fields }
}

describe('buildProgressSteps', () => {
  const labels = [
    'Request recorded',
    'Team checked',
    'Setting up GPT-4o in Azure',
    'Preparing your client secret'
  ]
  const T0 = '2026-10-21T10:40:00.000Z'
  const T1 = '2026-10-21T10:41:00.000Z'
  const T2 = '2026-10-21T10:42:00.000Z'
  const T3 = '2026-10-21T10:43:00.000Z'
  const T4 = '2026-10-21T10:44:00.000Z'
  const statusTimes = {
    requested: T0,
    'pr-raised': T1,
    merged: T2,
    deploying: T3,
    deployed: T3,
    verified: T4,
    active: T4
  }

  // `at` is when a done step finished, when the current one started, and
  // null for one not reached.
  test.each([
    ['requested', ['current', 'pending', 'pending', 'pending'], [T0]],
    ['pr-raised', ['done', 'current', 'pending', 'pending'], [T1, T1]],
    ['merged', ['done', 'done', 'current', 'pending'], [T1, T2, T2]],
    ['deploying', ['done', 'done', 'current', 'pending'], [T1, T2, T2]],
    ['deployed', ['done', 'done', 'done', 'current'], [T1, T2, T3, T3]],
    ['verified', ['done', 'done', 'done', 'current'], [T1, T2, T3, T3]],
    ['active', ['done', 'done', 'done', 'done'], [T1, T2, T3, T4]]
  ])('marks the steps and times for %s', (status, states, times) => {
    const steps = buildProgressSteps({ status, statusTimes }, 'GPT-4o')

    expect(steps.map(({ label }) => label)).toEqual(labels)
    expect(steps.map(({ state }) => state)).toEqual(states)
    expect(steps.map(({ at }) => at)).toEqual(
      [...times, null, null, null, null].slice(0, 4)
    )
  })

  test('reads a step the entry skipped as instant, starting when the next did', () => {
    const steps = buildProgressSteps(
      {
        status: 'deployed',
        statusTimes: { requested: T0, merged: T2, deployed: T3 }
      },
      'GPT-4o'
    )

    expect(steps.map(({ at }) => at)).toEqual([T2, T2, T3, T3])
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

    expect(active.map(({ at }) => at)).toEqual([T4, T4, T4, T4])
    expect(requested.map(({ at }) => at)).toEqual([T0, null, null, null])
  })

  test.each(['checks-failed', 'deploy-failed', 'removing', 'removed'])(
    'has no steps for %s',
    (status) => {
      expect(buildProgressSteps({ status }, 'GPT-4o')).toBeNull()
    }
  )
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

  describe('resources', () => {
    test('lists the team’s resources by name and kind only', () => {
      const view = toDeploymentView(doc, entry({ gitops: { resources } }))

      expect(view.resources).toEqual([
        { name: 'aip-alpha', kind: 'Foundry project', verified: true },
        { name: 'alpha-gpt-4o', kind: 'Model deployment', verified: true },
        { name: 'alpha', kind: 'API in API Management', verified: true }
      ])
      expect(JSON.stringify(view)).not.toContain('sub-secret')
    })

    test('does not call a resource verified before ARM has confirmed it', () => {
      const view = toDeploymentView(
        doc,
        entry({ status: 'deployed', gitops: { resources } })
      )

      expect(view.resources.every(({ verified }) => verified === false)).toBe(
        true
      )
    })

    test.each(['deployed', 'deploy-failed', 'removing'])(
      'does not call a resource verified while %s, since removal can follow a failed verification',
      (status) => {
        const view = toDeploymentView(
          doc,
          entry({ status, gitops: { resources } })
        )

        expect(view.resources.every(({ verified }) => verified === false)).toBe(
          true
        )
      }
    )

    test('is empty before the apply has reported any', () => {
      expect(toDeploymentView(doc, entry({ gitops: null })).resources).toEqual(
        []
      )
    })
  })

  describe('appRegistration', () => {
    test('is skipped where the apply made no registration', () => {
      expect(
        toDeploymentView(doc, entry({ gitops: { resources } })).appRegistration
      ).toBe('skipped')
    })

    test('is created where the apply made one', () => {
      const registered = {
        ...resources,
        registration: { client_id: 'c', object_id: 'o' }
      }

      expect(
        toDeploymentView(doc, entry({ gitops: { resources: registered } }))
          .appRegistration
      ).toBe('created')
    })

    test('is unknown before the apply has reported', () => {
      expect(
        toDeploymentView(doc, entry({ gitops: null })).appRegistration
      ).toBeNull()
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

  describe('verificationFailure', () => {
    const verification = {
      reason: 'environment-not-configured',
      attempts: 2,
      lastAttemptAt: '2026-10-19T10:00:00.000Z'
    }

    test.each(['deployed', 'deploy-failed'])(
      'reports why verification has not passed while %s',
      (status) => {
        const view = toDeploymentView(
          doc,
          entry({ status, gitops: { resources, verification } })
        )

        expect(view.verificationFailure).toEqual({
          reason: 'environment-not-configured',
          attempts: 2
        })
      }
    )

    test('reports nothing once the deployment has moved on', () => {
      const view = toDeploymentView(
        doc,
        entry({ status: 'active', gitops: { resources, verification } })
      )

      expect(view.verificationFailure).toBeNull()
    })
  })
})
