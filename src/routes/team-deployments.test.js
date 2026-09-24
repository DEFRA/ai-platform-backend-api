import { randomUUID } from 'node:crypto'

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('#team-deployments routes', () => {
  let server

  beforeAll(async () => {
    // Short mock stage duration so the "being set up" progression can be polled
    // in real time within a test without waiting on the production default.
    vi.stubEnv('TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS', '30')

    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
    vi.unstubAllEnvs()
  })

  async function createTeam(userId) {
    const { result } = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
      payload: { name: `Team ${userId}` }
    })

    return result.team._id
  }

  function postHeaders(userId) {
    return { 'x-user-id': userId, 'idempotency-key': randomUUID() }
  }

  test('POST /v1/teams/{teamId}/deployments requests a deployment for an active team member', async () => {
    const teamId = await createTeam('deploy-user-1')

    const { result, statusCode, headers } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-1'),
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    expect(statusCode).toBe(201)
    expect(headers.location).toBe(
      `/v1/teams/${teamId}/deployments/${result.deployment._id}`
    )
    expect(result.deployment.status).toBe('requested')
    expect(result.deployment.operationId).toBeTruthy()
  })

  test('POST /v1/teams/{teamId}/deployments rejects a non-dev environment', async () => {
    const teamId = await createTeam('deploy-user-2')

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-2'),
      payload: { modelSlug: 'gpt-4o', environment: 'qa' }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('environment-not-available')
  })

  test('POST /v1/teams/{teamId}/deployments rejects a model without the team tier', async () => {
    const teamId = await createTeam('deploy-user-3')

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-3'),
      payload: { modelSlug: 'gpt-4o-mini', environment: 'dev' }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('model-not-eligible')
  })

  test('POST /v1/teams/{teamId}/deployments returns 404 for a non-member', async () => {
    const teamId = await createTeam('deploy-user-4')

    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('someone-else'),
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    expect(statusCode).toBe(404)
  })

  test('POST /v1/teams/{teamId}/deployments rejects a duplicate request with a link to the existing one', async () => {
    const teamId = await createTeam('deploy-user-5')

    const first = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-5'),
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-5'),
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    expect(statusCode).toBe(409)
    expect(result.code).toBe('deployment-exists')
    expect(result.existingId).toBe(first.result.deployment._id.toString())
  })

  test('POST /v1/teams/{teamId}/deployments replays the original deployment for a repeated idempotency key', async () => {
    const teamId = await createTeam('deploy-user-13')
    const headers = postHeaders('deploy-user-13')

    const first = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers,
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers,
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    expect(statusCode).toBe(201)
    expect(result.deployment._id.toString()).toBe(
      first.result.deployment._id.toString()
    )
  })

  test('POST /v1/teams/{teamId}/deployments requires an idempotency key', async () => {
    const teamId = await createTeam('deploy-user-14')

    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: { 'x-user-id': 'deploy-user-14' },
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    expect(statusCode).toBe(400)
  })

  test('GET /v1/teams/{teamId}/deployments/{id} progresses through the GitOps states to active', async () => {
    const teamId = await createTeam('deploy-user-6')

    const created = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-6'),
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    const url = `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`
    const headers = { 'x-user-id': 'deploy-user-6' }

    const first = await server.inject({ method: 'GET', url, headers })

    expect(first.result.deployment.status).toBe('requested')

    await wait(300)

    const second = await server.inject({ method: 'GET', url, headers })

    expect(second.result.deployment.status).toBe('active')
    expect(second.result.deployment.activatedAt).toBeTruthy()
  })

  test('GET /v1/teams/{teamId}/deployments/{id} returns 404 for a non-member', async () => {
    const teamId = await createTeam('deploy-user-7')

    const created = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-7'),
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    const { statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`,
      headers: { 'x-user-id': 'someone-else' }
    })

    expect(statusCode).toBe(404)
  })

  test('GET /v1/teams/{teamId}/deployments/{id} lands on checks-failed for the reserved test prefix', async () => {
    const teamId = await createTeam('test-checks-fail-8')

    const created = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('test-checks-fail-8'),
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    await wait(100)

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`,
      headers: { 'x-user-id': 'test-checks-fail-8' }
    })

    expect(result.deployment.status).toBe('checks-failed')
    expect(result.deployment.failureReason).toBeTruthy()
  })

  test('GET /v1/teams/{teamId}/deployments/{id} lands on deploy-failed for the reserved test prefix', async () => {
    const teamId = await createTeam('test-deploy-fail-9')

    const created = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('test-deploy-fail-9'),
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    await wait(300)

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`,
      headers: { 'x-user-id': 'test-deploy-fail-9' }
    })

    expect(result.deployment.status).toBe('deploy-failed')
    expect(result.deployment.failureReason).toBeTruthy()
  })

  test('GET /v1/teams/{teamId}/deployments lists every deployment for a team', async () => {
    const teamId = await createTeam('deploy-user-10')

    const created = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-10'),
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments`,
      headers: { 'x-user-id': 'deploy-user-10' }
    })

    expect(statusCode).toBe(200)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]._id.toString()).toBe(
      created.result.deployment._id.toString()
    )
    expect(result.items[0].modelSlug).toBe('gpt-4o')
  })

  test('GET /v1/teams/{teamId}/deployments returns 404 for a non-member', async () => {
    const teamId = await createTeam('deploy-user-11')

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-11'),
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    const { statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments`,
      headers: { 'x-user-id': 'someone-else' }
    })

    expect(statusCode).toBe(404)
  })

  test('GET /v1/teams/{teamId}/deployments reflects refreshed status', async () => {
    const teamId = await createTeam('deploy-user-12')

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-12'),
      payload: { modelSlug: 'gpt-4o', environment: 'dev' }
    })

    await wait(300)

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments`,
      headers: { 'x-user-id': 'deploy-user-12' }
    })

    expect(result.items[0].status).toBe('active')
  })
})
