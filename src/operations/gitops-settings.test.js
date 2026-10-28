import { config } from '#/config.js'
import { gitopsSettings } from '#/operations/gitops-settings.js'

const KEYS = [
  'gitops.tenantsRepo',
  'gitops.deploymentsRepo',
  'teamDeployment.environments',
  'gitops.deadlineRequestedMs',
  'gitops.deadlineCommittedMs',
  'gitops.deadlineDeployingMs',
  'gitops.deadlineDeployedMs',
  'gitops.reconcileGraceMs',
  'gitops.resubmitMax',
  'gitops.revertGraceMs',
  'gitops.deadlineHeldMs',
  'gitops.heldAlarmMs',
  'gitops.verifyMaxAttempts',
  'gitops.outboxSweepMs',
  'gitops.sweepIntervalMs'
]

describe('gitops-settings', () => {
  const originals = Object.fromEntries(
    KEYS.map((key) => [key, config.get(key)])
  )

  afterEach(() => {
    for (const key of KEYS) {
      config.set(key, originals[key])
    }
  })

  test('reads every setting from the configuration', () => {
    const settings = gitopsSettings()

    expect(settings).toEqual({
      repositories: {
        tenants: originals['gitops.tenantsRepo'],
        deployments: originals['gitops.deploymentsRepo']
      },
      environments: originals['teamDeployment.environments'],
      deadlines: {
        requested: originals['gitops.deadlineRequestedMs'],
        committed: originals['gitops.deadlineCommittedMs'],
        deploying: originals['gitops.deadlineDeployingMs'],
        deployed: originals['gitops.deadlineDeployedMs']
      },
      reconcileGraceMs: originals['gitops.reconcileGraceMs'],
      resubmitMax: originals['gitops.resubmitMax'],
      revertGraceMs: originals['gitops.revertGraceMs'],
      deadlineHeldMs: originals['gitops.deadlineHeldMs'],
      heldAlarmMs: originals['gitops.heldAlarmMs'],
      verifyMaxAttempts: originals['gitops.verifyMaxAttempts'],
      outboxSweepMs: originals['gitops.outboxSweepMs'],
      sweepIntervalMs: originals['gitops.sweepIntervalMs'],
      outboxLeaseMs: 30000
    })
  })

  test('holds the documented defaults', () => {
    expect(gitopsSettings()).toMatchObject({
      repositories: {
        tenants: 'DEFRA/ai-platform-tenants',
        deployments: 'DEFRA/ai-platform-deployments'
      },
      deadlines: {
        requested: 600000,
        committed: 1800000,
        deploying: 2700000,
        deployed: 900000
      },
      reconcileGraceMs: 600000,
      resubmitMax: 3,
      revertGraceMs: 300000,
      deadlineHeldMs: 1800000,
      heldAlarmMs: 3600000,
      verifyMaxAttempts: 5
    })
  })

  test('follows a change to the configuration', () => {
    config.set('gitops.resubmitMax', 7)
    config.set('gitops.tenantsRepo', 'DEFRA/other-tenants')

    const settings = gitopsSettings()

    expect(settings.resubmitMax).toBe(7)
    expect(settings.repositories.tenants).toBe('DEFRA/other-tenants')
  })

  test('lets an override replace any setting, outboxLeaseMs included', () => {
    const settings = gitopsSettings({
      outboxLeaseMs: 20,
      verifyMaxAttempts: 2,
      environments: ['infradev']
    })

    expect(settings).toMatchObject({
      outboxLeaseMs: 20,
      verifyMaxAttempts: 2,
      environments: ['infradev']
    })
    expect(settings.reconcileGraceMs).toBe(originals['gitops.reconcileGraceMs'])
  })

  test('adds a setting that is not configured', () => {
    expect(gitopsSettings({ extra: 1 }).extra).toBe(1)
  })
})
