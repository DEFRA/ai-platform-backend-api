import { mockTenantOrchestrator } from '#/adapters/mock-tenant-orchestrator.js'
import { describeTenantOrchestratorContract } from '#/adapters/tenant-orchestrator-contract.js'

describeTenantOrchestratorContract('mock', () => mockTenantOrchestrator)

describe('mockTenantOrchestrator', () => {
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  async function statusAfterEveryStage(requestedBy, operationId) {
    await mockTenantOrchestrator.requestDeployment({ operationId, requestedBy })

    return mockTenantOrchestrator.getDeploymentStatus({
      operationId,
      createdAt: longAgo
    })
  }

  test('reaches active once every stage has elapsed', async () => {
    const status = await statusAfterEveryStage(
      'entra:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      'mock-op-00000001'
    )

    expect(status).toEqual({
      operationId: 'mock-op-00000001',
      status: 'active',
      links: {}
    })
  })

  test('lands on checks-failed for the reserved requester range', async () => {
    const status = await statusAfterEveryStage(
      'entra:00000000-0000-0000-0001-000000000001',
      'mock-op-00000002'
    )

    expect(status.status).toBe('checks-failed')
    expect(status.failureReason).toContain('checks failed')
  })

  test('lands on deploy-failed with no run report attribution for the reserved range', async () => {
    const status = await statusAfterEveryStage(
      'entra:00000000-0000-0000-0002-000000000001',
      'mock-op-00000003'
    )

    expect(status.status).toBe('deploy-failed')
    expect(status).not.toHaveProperty('failure')
  })
})
