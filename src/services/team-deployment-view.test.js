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
    'Setting up access in Azure',
    'Checking and preparing your client secret'
  ]

  test.each([
    ['requested', ['current', 'pending', 'pending', 'pending']],
    ['pr-raised', ['done', 'current', 'pending', 'pending']],
    ['merged', ['done', 'done', 'current', 'pending']],
    ['deploying', ['done', 'done', 'current', 'pending']],
    ['deployed', ['done', 'done', 'done', 'current']],
    ['verified', ['done', 'done', 'done', 'current']],
    ['active', ['done', 'done', 'done', 'done']]
  ])('marks the steps for %s', (status, states) => {
    const steps = buildProgressSteps(status)

    expect(steps.map(({ label }) => label)).toEqual(labels)
    expect(steps.map(({ state }) => state)).toEqual(states)
  })

  test.each(['checks-failed', 'deploy-failed', 'removing', 'removed'])(
    'has no steps for %s',
    (status) => {
      expect(buildProgressSteps(status)).toBeNull()
    }
  )
})

describe('toDeploymentView', () => {
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
