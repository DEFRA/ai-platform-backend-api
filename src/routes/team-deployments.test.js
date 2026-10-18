import { randomUUID } from 'node:crypto'

const ENTRA_TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'
// The mock orchestrator's reserved requester ranges, by test name prefix.
const FORCED_FAILURE_OID_RANGES = {
  'test-checks-fail-': '00000000-0000-0000-0001-',
  'test-deploy-fail-': '00000000-0000-0000-0002-'
}

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

  async function createTeam(label) {
    await signIn(label)

    const { result } = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: postHeaders(label),
      payload: { name: `Team ${label}`, serviceCode: 'ABC' }
    })

    return result.team._id
  }

  // Each test names its person; createTeam signs them in, and x-user-id is
  // then their user _id. A name nobody signed in as (a non-member) is sent
  // as is. A `test-checks-fail-`/`test-deploy-fail-` name gets an object ID
  // in the mock orchestrator's reserved range for that failure.
  const userIds = new Map()

  function oidFor(label) {
    const [, range] =
      Object.entries(FORCED_FAILURE_OID_RANGES).find(([prefix]) =>
        label.startsWith(prefix)
      ) ?? []

    return range ? `${range}${randomUUID().slice(-12)}` : randomUUID()
  }

  async function signIn(label) {
    const { result } = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: oidFor(label),
        tid: ENTRA_TENANT_ID,
        email: `${label}@defra.gov.uk`,
        displayName: label
      }
    })

    userIds.set(label, result.user._id.toString())
  }

  function userHeaders(label) {
    return { 'x-user-id': userIds.get(label) ?? label }
  }

  function postHeaders(label) {
    return { ...userHeaders(label), 'idempotency-key': randomUUID() }
  }

  test('POST /v1/teams/{teamId}/deployments refuses a member with no Entra object ID to attribute it to', async () => {
    const userId = 'deploy-user-unbound'
    const { result: created } = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
      payload: { name: `Team ${userId}`, serviceCode: 'ABC' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${created.team._id}/deployments`,
      headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('entra-identity-required')
  })

  test('POST /v1/teams/{teamId}/deployments requests a deployment for an active team member', async () => {
    const teamId = await createTeam('deploy-user-1')

    const { result, statusCode, headers } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-1'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    expect(statusCode).toBe(201)
    expect(headers.location).toBe(
      `/v1/teams/${teamId}/deployments/${result.deployment._id}`
    )
    expect(result.deployment.status).toBe('requested')
    expect(result.deployment.operationId).toBeTruthy()
    // The mock orchestrator has no GitHub runs or pull request to link to.
    expect(result.deployment.links).toEqual({})

    const stored = await server.db
      .collection('teamDeployments')
      .findOne({ teamId: teamId.toString() })

    expect(stored.deployments[0]).toMatchObject({
      orchestrator: 'mock',
      gitops: null
    })
  })

  test('POST /v1/teams/{teamId}/deployments refuses an environment this instance does not deploy to', async () => {
    const teamId = await createTeam('deploy-user-2')

    // 'infradev' is a schema-valid registry name; only the environments in
    // TEAM_ENVIRONMENTS (sandbox, in these tests) are allowed from here.
    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-2'),
      payload: { modelSlug: 'gpt-4o', environment: 'infradev' }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('environment-not-available')
  })

  test('POST /v1/teams/{teamId}/deployments rejects an environment that is not a registry name', async () => {
    const teamId = await createTeam('deploy-user-2b')

    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-2b'),
      payload: { modelSlug: 'gpt-4o', environment: 'Infra Dev' }
    })

    expect(statusCode).toBe(400)
  })

  test('POST /v1/teams/{teamId}/deployments rejects a model without the team tier', async () => {
    const teamId = await createTeam('deploy-user-3')

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-3'),
      payload: { modelSlug: 'gpt-5-nano', environment: 'sandbox' }
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
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    expect(statusCode).toBe(404)
  })

  test('POST /v1/teams/{teamId}/deployments rejects a duplicate request with a link to the existing one', async () => {
    const teamId = await createTeam('deploy-user-5')

    const first = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-5'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-5'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    expect(statusCode).toBe(409)
    expect(result.code).toBe('deployment-exists')
    expect(result.existingId).toBe(first.result.deployment._id.toString())
  })

  test('POST /v1/teams/{teamId}/deployments extends the same team+environment document with a second model', async () => {
    const teamId = await createTeam('deploy-user-16')

    const first = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-16'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    const second = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-16'),
      payload: { modelSlug: 'gpt-4-1-nano', environment: 'sandbox' }
    })

    expect(second.statusCode).toBe(201)
    expect(second.result.deployment._id).not.toBe(
      first.result.deployment._id.toString()
    )

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments`,
      headers: userHeaders('deploy-user-16')
    })

    expect(result.items.map((item) => item.modelSlug).sort()).toEqual([
      'gpt-4-1-nano',
      'gpt-4o'
    ])
    expect(new Set(result.items.map((item) => item.teamId)).size).toBe(1)
  })

  test('POST /v1/teams/{teamId}/deployments replays the original deployment for a repeated idempotency key', async () => {
    const teamId = await createTeam('deploy-user-13')
    const headers = postHeaders('deploy-user-13')

    const first = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers,
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers,
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
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
      headers: userHeaders('deploy-user-14'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    expect(statusCode).toBe(400)
  })

  test('GET /v1/teams/{teamId}/deployments/{id} progresses through the GitOps states to active', async () => {
    const teamId = await createTeam('deploy-user-6')

    const created = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-6'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    const url = `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`
    const headers = userHeaders('deploy-user-6')

    const first = await server.inject({ method: 'GET', url, headers })

    expect(first.result.deployment.status).toBe('requested')

    await wait(300)

    const second = await server.inject({ method: 'GET', url, headers })

    expect(second.result.deployment.status).toBe('active')
    expect(second.result.deployment.activatedAt).toBeTruthy()
  })

  test('GET /v1/teams/{teamId}/deployments/{id} exposes the four fixed progress step labels', async () => {
    const teamId = await createTeam('deploy-user-6b')

    const created = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-6b'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    expect(
      created.result.deployment.progressSteps.map((step) => step.label)
    ).toEqual([
      'Request recorded',
      'Team checked',
      'Setting up access in Azure',
      'Creating your client secret'
    ])
    expect(created.result.deployment.progressSteps[0].state).toBe('current')
    expect(created.result.deployment.progressSteps[1].state).toBe('pending')

    const url = `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`
    const headers = userHeaders('deploy-user-6b')

    await wait(300)

    const afterActive = await server.inject({ method: 'GET', url, headers })

    expect(afterActive.result.deployment.status).toBe('active')
    expect(
      afterActive.result.deployment.progressSteps.map((step) => step.state)
    ).toEqual(['done', 'done', 'done', 'current'])
  })

  test('GET /v1/teams/{teamId}/deployments/{id} has no progress steps for a failed deployment', async () => {
    const teamId = await createTeam('test-checks-fail-6c')

    const created = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('test-checks-fail-6c'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    const url = `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`
    const headers = userHeaders('test-checks-fail-6c')

    await wait(300)

    const { result } = await server.inject({ method: 'GET', url, headers })

    expect(result.deployment.status).toBe('checks-failed')
    expect(result.deployment.progressSteps).toBeNull()
  })

  test('GET /v1/teams/{teamId}/deployments/{id} returns 404 for a non-member', async () => {
    const teamId = await createTeam('deploy-user-7')

    const created = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-7'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    const { statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`,
      headers: userHeaders('someone-else')
    })

    expect(statusCode).toBe(404)
  })

  test('GET /v1/teams/{teamId}/deployments/{id} lands on checks-failed for the reserved test prefix', async () => {
    const teamId = await createTeam('test-checks-fail-8')

    const created = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('test-checks-fail-8'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    await wait(100)

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`,
      headers: userHeaders('test-checks-fail-8')
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
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    await wait(300)

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`,
      headers: userHeaders('test-deploy-fail-9')
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
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments`,
      headers: userHeaders('deploy-user-10')
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
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    const { statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments`,
      headers: userHeaders('someone-else')
    })

    expect(statusCode).toBe(404)
  })

  test('a second request waits as queued behind the one in flight, then is dispatched once that ends', async () => {
    const teamId = await createTeam('deploy-user-18')

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-18'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    const queued = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-18'),
      payload: { modelSlug: 'gpt-4-1-nano', environment: 'sandbox' }
    })

    expect(queued.statusCode).toBe(201)
    expect(queued.result.deployment.status).toBe('queued')

    const url = `/v1/teams/${teamId}/deployments/${queued.result.deployment._id}`

    await wait(300)

    // Polling the queued request polls the one holding the team file, which
    // has finished, so the queued one is dispatched.
    const dispatched = await server.inject({
      method: 'GET',
      url,
      headers: userHeaders('deploy-user-18')
    })

    expect(dispatched.result.deployment.status).toBe('requested')
  })

  test('GET /v1/teams/{teamId}/deployments reflects refreshed status', async () => {
    const teamId = await createTeam('deploy-user-12')

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-12'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    await wait(300)

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments`,
      headers: userHeaders('deploy-user-12')
    })

    expect(result.items[0].status).toBe('active')
  })

  test('concurrent polls never regress a deployment status', async () => {
    const teamId = await createTeam('deploy-user-15')

    const created = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders('deploy-user-15'),
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    const url = `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`
    const headers = userHeaders('deploy-user-15')

    await wait(300)

    // Every poll races to persist the status it read; a stale writer must not
    // overwrite a newer one, so all of them must agree on the terminal state.
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        server.inject({ method: 'GET', url, headers })
      )
    )

    expect(
      responses.map((response) => response.result.deployment.status)
    ).toEqual(Array.from({ length: 8 }, () => 'active'))

    const after = await server.inject({ method: 'GET', url, headers })

    expect(after.result.deployment.status).toBe('active')
  })

  describe('DELETE /v1/teams/{teamId}/deployments/{id}', () => {
    async function activeDeployment(label) {
      const teamId = await createTeam(label)
      const created = await server.inject({
        method: 'POST',
        url: `/v1/teams/${teamId}/deployments`,
        headers: postHeaders(label),
        payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
      })
      const url = `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`

      await wait(300)
      await server.inject({ method: 'GET', url, headers: userHeaders(label) })

      return { teamId, url }
    }

    test('removes an active model for a team admin and withdraws its grant', async () => {
      const { teamId, url } = await activeDeployment('remove-user-1')

      const { result, statusCode } = await server.inject({
        method: 'DELETE',
        url,
        headers: userHeaders('remove-user-1')
      })

      expect(statusCode).toBe(200)
      expect(result.deployment).toMatchObject({
        status: 'removed',
        removedAt: expect.any(String),
        progressSteps: null
      })
      const stored = await server.db
        .collection('teamDeployments')
        .findOne({ teamId: teamId.toString() })
      expect(stored.gateway.allowedDeployments).toEqual([])

      const listed = await server.inject({
        method: 'GET',
        url: `/v1/teams/${teamId}/deployments`,
        headers: userHeaders('remove-user-1')
      })
      expect(listed.result.items.map((item) => item.status)).toEqual([
        'removed'
      ])
    })

    test('refuses a model still being set up', async () => {
      const teamId = await createTeam('remove-user-2')
      const created = await server.inject({
        method: 'POST',
        url: `/v1/teams/${teamId}/deployments`,
        headers: postHeaders('remove-user-2'),
        payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
      })

      const { result, statusCode } = await server.inject({
        method: 'DELETE',
        url: `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`,
        headers: userHeaders('remove-user-2')
      })

      expect(statusCode).toBe(409)
      expect(result.code).toBe('deployment-in-progress')
    })

    test('is for team admins only', async () => {
      const { teamId, url } = await activeDeployment('remove-user-3')
      await signIn('remove-member-3')
      // An active member without the admin role.
      await server.db.collection('teamMembers').insertOne({
        teamId: teamId.toString(),
        userId: userHeaders('remove-member-3')['x-user-id'],
        role: 'user',
        status: 'active'
      })

      const { result, statusCode } = await server.inject({
        method: 'DELETE',
        url,
        headers: userHeaders('remove-member-3')
      })

      expect(statusCode).toBe(403)
      expect(result.code).toBe('admin-required')
    })

    test('returns 404 for a non-member and for an unknown deployment', async () => {
      const { teamId, url } = await activeDeployment('remove-user-4')

      const stranger = await server.inject({
        method: 'DELETE',
        url,
        headers: userHeaders('remove-stranger-4')
      })
      const unknown = await server.inject({
        method: 'DELETE',
        url: `/v1/teams/${teamId}/deployments/${randomUUID()}`,
        headers: userHeaders('remove-user-4')
      })

      expect(stranger.statusCode).toBe(404)
      expect(unknown.statusCode).toBe(404)
    })
  })
})
