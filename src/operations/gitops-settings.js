import { config } from '#/config.js'

/**
 * The settings the operations modules share, read from configuration (plan 5,
 * "Configuration"). Pass `overrides` to change any in a test.
 * @param {object} [overrides]
 * @returns {{repositories: {tenants: string, deployments: string}, environments: string[], deadlines: Record<string, number>, reconcileGraceMs: number, resubmitMax: number, revertGraceMs: number, deadlineHeldMs: number, heldAlarmMs: number, verifyMaxAttempts: number, outboxSweepMs: number, sweepIntervalMs: number, outboxLeaseMs: number}}
 */
export function gitopsSettings(overrides = {}) {
  return {
    repositories: {
      tenants: config.get('gitops.tenantsRepo'),
      deployments: config.get('gitops.deploymentsRepo')
    },
    environments: config.get('teamDeployment.environments'),
    deadlines: {
      requested: config.get('gitops.deadlineRequestedMs'),
      committed: config.get('gitops.deadlineCommittedMs'),
      deploying: config.get('gitops.deadlineDeployingMs'),
      deployed: config.get('gitops.deadlineDeployedMs')
    },
    reconcileGraceMs: config.get('gitops.reconcileGraceMs'),
    resubmitMax: config.get('gitops.resubmitMax'),
    revertGraceMs: config.get('gitops.revertGraceMs'),
    deadlineHeldMs: config.get('gitops.deadlineHeldMs'),
    heldAlarmMs: config.get('gitops.heldAlarmMs'),
    verifyMaxAttempts: config.get('gitops.verifyMaxAttempts'),
    outboxSweepMs: config.get('gitops.outboxSweepMs'),
    sweepIntervalMs: config.get('gitops.sweepIntervalMs'),
    // How long an instance owns an outbox entry it is publishing (plan 5).
    outboxLeaseMs: 30000,
    ...overrides
  }
}
