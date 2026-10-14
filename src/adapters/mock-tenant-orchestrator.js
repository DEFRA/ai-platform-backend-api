import { config } from '#/config.js'

// Design C's real GitOps operation states, in order (see the GitOps
// contract's operation-state table). The mock advances through these purely
// as a function of elapsed time since the request, so status can be polled
// with no background timer or interval to manage.
const HAPPY_PATH_STAGES = [
  'requested',
  'pr-raised',
  'merged',
  'deploying',
  'deployed',
  'verified',
  'active'
]

// Reserved-test-pattern failure simulation, same approach as the mock credential
// issuer's `test-fail-` userId prefix: a requester id with one of these prefixes
// makes the mock orchestrator land on a terminal failure state instead of `active`.
const FORCED_CHECKS_FAILED_PREFIX = 'test-checks-fail-'
const FORCED_DEPLOY_FAILED_PREFIX = 'test-deploy-fail-'

// Keyed by operationId so a later getDeploymentStatus poll (a separate call,
// possibly on a different request) still knows about the forced outcome.
const forcedOutcomes = new Map()

/**
 * Mock TenantOrchestrator for local development and tests, standing in for
 * the GitHub adapter (submit workflow, Terraform apply via GitOps, ARM
 * verification). It has no workflow runs, pull requests or run reports, so
 * it returns no links, no run IDs and no `failure` attribution - a forced
 * `deploy-failed` is therefore final at once, with nothing to retry or
 * revert.
 * @type {import('./tenant-orchestrator.js').TenantOrchestrator}
 */
export const mockTenantOrchestrator = {
  async requestDeployment({ operationId, requestedBy }) {
    if (requestedBy?.startsWith(FORCED_CHECKS_FAILED_PREFIX)) {
      forcedOutcomes.set(operationId, 'checks-failed')
    } else if (requestedBy?.startsWith(FORCED_DEPLOY_FAILED_PREFIX)) {
      forcedOutcomes.set(operationId, 'deploy-failed')
    }

    return {
      operationId,
      status: 'requested',
      submitRunId: null,
      submitRunUrl: null
    }
  },

  async getDeploymentStatus({ operationId, createdAt }) {
    const stageDurationMs = config.get('teamDeployment.mockStageDurationMs')
    const elapsedMs = Date.now() - new Date(createdAt).getTime()
    const stageIndex = Math.min(
      Math.floor(elapsedMs / stageDurationMs),
      HAPPY_PATH_STAGES.length - 1
    )
    const forcedOutcome = forcedOutcomes.get(operationId)

    if (forcedOutcome === 'checks-failed' && stageIndex >= 1) {
      return {
        operationId,
        status: 'checks-failed',
        failureReason: 'Automated checks failed on the desired-state PR (mock)',
        links: {}
      }
    }

    if (forcedOutcome === 'deploy-failed' && stageIndex >= 3) {
      return {
        operationId,
        status: 'deploy-failed',
        failureReason: 'Deploy workflow failed to reconcile the stack (mock)',
        links: {}
      }
    }

    return { operationId, status: HAPPY_PATH_STAGES[stageIndex], links: {} }
  },

  async requestApply() {
    return { runId: null, runUrl: null }
  },

  async getPreviousDocument() {
    return { document: null }
  }
}
