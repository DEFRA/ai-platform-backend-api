import { randomUUID } from 'node:crypto'

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('#admin team-deployments routes', () => {
  let server
  let adminId

  beforeAll(async () => {
    // Short mock stage duration so a forced deploy failure is reached quickly.
    vi.stubEnv('TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS', '30')

    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()

    const { insertedId } = await server.db.collection('users').insertOne({
      email: 'route-platform-admin@defra.gov.uk',
      displayName: 'Platform Admin',
      roles: ['research-user', 'platform-admin']
    })

    adminId = insertedId.toString()
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
    vi.unstubAllEnvs()
  })

  // A mock-orchestrated deployment that has landed on deploy-failed: its
  // requester's object ID is in the mock's reserved deploy-failed range.
  async function failedDeployment() {
    const { result: signedIn } = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: `00000000-0000-0000-0002-${randomUUID().slice(-12)}`,
        tid: '6f504113-6b64-43f2-ade9-242e05780007',
        email: 'deploy-failed-requester@defra.gov.uk',
        displayName: 'Deploy Failed Requester'
      }
    })
    const userId = signedIn.user._id.toString()
    const { result: created } = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
      payload: {
        name: `Admin routes ${randomUUID().slice(-12)}`,
        serviceCode: 'ABC'
      }
    })
    const teamId = created.team._id
    const { result } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    await wait(300)

    const { result: polled } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments/${result.deployment._id}`,
      headers: { 'x-user-id': userId }
    })

    expect(polled.deployment.status).toBe('deploy-failed')

    return polled.deployment
  }

  test('POST /v1/admin/team-deployments/{id}/retry dispatches a fresh apply and resumes the deployment', async () => {
    const deployment = await failedDeployment()

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/admin/team-deployments/${deployment._id}/retry`,
      headers: { 'x-user-id': adminId }
    })

    expect(statusCode).toBe(202)
    expect(result.deployment.status).toBe('deploying')
    expect(result.deployment.failureReason).toBeNull()
  })

  test('POST /v1/admin/team-deployments/{id}/reconcile is recorded as a reconcile', async () => {
    const deployment = await failedDeployment()

    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/admin/team-deployments/${deployment._id}/reconcile`,
      headers: { 'x-user-id': adminId }
    })

    expect(statusCode).toBe(202)
    expect(
      await server.db.collection('auditEvents').findOne({
        resourceId: deployment._id,
        action: 'teamDeployment.reconcile'
      })
    ).toMatchObject({ actorUserId: adminId, outcome: 'success' })
  })

  test('POST /v1/admin/team-deployments/{id}/retry refuses anyone who is not a Platform Admin', async () => {
    const deployment = await failedDeployment()

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/admin/team-deployments/${deployment._id}/retry`,
      headers: { 'x-user-id': deployment.requestedBy }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('platform-admin-required')
  })

  test('POST /v1/admin/team-deployments/{id}/retry returns 404 for an unknown deployment', async () => {
    const { statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/admin/team-deployments/no-such-deployment/retry',
      headers: { 'x-user-id': adminId }
    })

    expect(statusCode).toBe(404)
  })

  test('POST /v1/admin/team-deployments/{id}/retry requires the x-user-id header', async () => {
    const { statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/admin/team-deployments/any/retry'
    })

    expect(statusCode).toBe(400)
  })
})
