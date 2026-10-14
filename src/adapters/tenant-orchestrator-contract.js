const CONTRACT_STATES = [
  'requested',
  'pr-raised',
  'merged',
  'deploying',
  'deployed',
  'verified',
  'active',
  'checks-failed',
  'deploy-failed'
]

const operationId = 'contract-op-00000001'
const path = 'environments/infradev/alpha.json'
const request = {
  environment: 'infradev',
  path,
  document: {
    schemaVersion: 1,
    revision: 1,
    environment: 'infradev',
    operationId,
    team: { slug: 'alpha', serviceCode: 'ZZZ' }
  },
  operationId,
  requestedBy: 'contract-user-1',
  expectedRevision: 0,
  action: 'write'
}

function isNullableInteger(value) {
  return value === null || Number.isInteger(value)
}

function isNullableString(value) {
  return value === null || typeof value === 'string'
}

function sortedKeysOf(value) {
  return Object.keys(value).sort((a, b) => a.localeCompare(b))
}

/**
 * Shared `TenantOrchestrator` contract suite, run against every adapter (the
 * mock and the nocked GitHub adapter) so Liskov substitution is enforced by
 * an executable test, not asserted in prose. Asserts the shapes the service
 * relies on: the operation ID is echoed, run IDs and URLs are present or
 * explicitly null, every status is a GitOps contract state with a `links`
 * object, and a missing previous file is `null`.
 * @param {string} name
 * @param {() => import('./tenant-orchestrator.js').TenantOrchestrator} createOrchestrator
 * @param {{arrange?: () => void}} [options] - sets up network fixtures (nock) before each test
 */
export function describeTenantOrchestratorContract(
  name,
  createOrchestrator,
  { arrange = () => {} } = {}
) {
  describe(`TenantOrchestrator contract: ${name}`, () => {
    beforeEach(() => {
      arrange()
    })

    test('requestDeployment returns the operation ID as requested, with the submit run or nulls', async () => {
      const submitted = await createOrchestrator().requestDeployment(request)

      expect(sortedKeysOf(submitted)).toEqual([
        'operationId',
        'status',
        'submitRunId',
        'submitRunUrl'
      ])
      expect(submitted.operationId).toBe(operationId)
      expect(submitted.status).toBe('requested')
      expect(isNullableInteger(submitted.submitRunId)).toBe(true)
      expect(isNullableString(submitted.submitRunUrl)).toBe(true)
    })

    test('getDeploymentStatus reports a contract state with links for a just-requested entry', async () => {
      const orchestrator = createOrchestrator()
      const submitted = await orchestrator.requestDeployment(request)
      const status = await orchestrator.getDeploymentStatus({
        operationId,
        environment: 'infradev',
        status: 'requested',
        createdAt: new Date().toISOString(),
        gitops: {
          path,
          action: 'write',
          submitRunId: submitted.submitRunId,
          submitRunUrl: submitted.submitRunUrl
        }
      })

      expect(status.operationId).toBe(operationId)
      expect(CONTRACT_STATES).toContain(status.status)
      expect(status.links).toEqual(expect.any(Object))
    })

    test('requestApply returns the apply run or nulls', async () => {
      const applied = await createOrchestrator().requestApply({
        environment: 'infradev',
        reason: `retry ${operationId}`
      })

      expect(sortedKeysOf(applied)).toEqual(['runId', 'runUrl'])
      expect(isNullableInteger(applied.runId)).toBe(true)
      expect(isNullableString(applied.runUrl)).toBe(true)
    })

    test('getPreviousDocument returns null for a file that did not exist before the merge', async () => {
      const previous = await createOrchestrator().getPreviousDocument({
        path,
        mergeSha: 'contract-merge-sha'
      })

      expect(previous).toEqual({ document: null })
    })
  })
}
