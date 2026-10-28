import { randomUUID } from 'node:crypto'

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

  // The mock orchestrator sends its events in the background: this waits
  // until it has sent every one it has been given.
  function settled() {
    return server.app.operations.transport.worker.idle()
  }

  // A mock-orchestrated deployment. With `failing` its requester's object ID
  // is in the mock's reserved deploy-failed range, so it lands on
  // deploy-failed; otherwise it goes on to active.
  async function deployment({ failing = false } = {}) {
    const oid = failing
      ? `00000000-0000-0000-0002-${randomUUID().slice(-12)}`
      : randomUUID()
    const { result: signedIn } = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid,
        tid: '6f504113-6b64-43f2-ade9-242e05780007',
        email: `requester-${oid}@defra.gov.uk`,
        displayName: 'Requester'
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
      payload: { modelSlugs: ['gpt-4o'], environment: 'sandbox' }
    })

    await settled()

    const { result: polled } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments/${result.deployments[0]._id}`,
      headers: { 'x-user-id': userId }
    })

    return polled.deployment
  }

  async function failedDeployment() {
    const failed = await deployment({ failing: true })

    expect(failed.status).toBe('deploy-failed')

    return failed
  }

  function admin(id, action) {
    return server.inject({
      method: 'POST',
      url: `/v1/admin/team-deployments/${id}/${action}`,
      headers: { 'x-user-id': adminId }
    })
  }

  test('POST /v1/admin/team-deployments/{id}/retry publishes a fresh apply and resumes the deployment', async () => {
    const failed = await failedDeployment()

    const { result, statusCode } = await admin(failed._id, 'retry')

    expect(statusCode).toBe(202)
    expect(result.deployment.status).toBe('deploying')
    expect(result.deployment.failureReason).toBeNull()
    expect(result.deployment.operation).toMatchObject({
      id: failed.operationId,
      state: 'deploying',
      attempt: 2
    })

    // The retry's apply goes through in the mock, so the deployment ends active.
    await settled()

    const stored = await server.db
      .collection('operations')
      .findOne({ _id: failed.operationId })

    expect(stored).toMatchObject({ state: 'active', attempt: 2 })
  })

  test('POST /v1/admin/team-deployments/{id}/retry refuses a deployment that has not failed', async () => {
    const active = await deployment()

    expect(active.status).toBe('active')

    const { result, statusCode } = await admin(active._id, 'retry')

    expect(statusCode).toBe(409)
    expect(result.code).toBe('deployment-not-retryable')
  })

  test('POST /v1/admin/team-deployments/{id}/reconcile is recorded as a reconcile and publishes one', async () => {
    const failed = await failedDeployment()

    const { statusCode } = await admin(failed._id, 'reconcile')

    expect(statusCode).toBe(202)
    expect(
      await server.db.collection('auditEvents').findOne({
        resourceId: failed._id,
        action: 'teamDeployment.reconcile'
      })
    ).toMatchObject({ actorUserId: adminId, outcome: 'success' })

    const stored = await server.db
      .collection('operations')
      .findOne({ _id: failed.operationId })

    expect(stored.outbox.map(({ type }) => type)).toContain('reconcile')
  })

  test('POST /v1/admin/team-deployments/{id}/retry refuses anyone who is not a Platform Admin', async () => {
    const failed = await failedDeployment()

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/admin/team-deployments/${failed._id}/retry`,
      headers: { 'x-user-id': failed.requestedBy }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('platform-admin-required')
  })

  test('POST /v1/admin/team-deployments/{id}/reconcile refuses anyone who is not a Platform Admin', async () => {
    const failed = await failedDeployment()

    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/admin/team-deployments/${failed._id}/reconcile`,
      headers: { 'x-user-id': failed.requestedBy }
    })

    expect(statusCode).toBe(403)
  })

  test('POST /v1/admin/team-deployments/{id}/retry returns 404 for an unknown deployment', async () => {
    const { statusCode } = await admin('no-such-deployment', 'retry')

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
