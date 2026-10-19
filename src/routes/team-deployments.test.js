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

  // Requests models for a team as the named member.
  function requestModels(
    teamId,
    label,
    modelSlugs,
    { environment = 'sandbox' } = {}
  ) {
    return server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: postHeaders(label),
      payload: { modelSlugs, environment }
    })
  }

  // The single-model case, which most tests make: the response keeps its one
  // deployment as `result.deployment`.
  async function requestModel(
    teamId,
    label,
    modelSlug = 'gpt-4o',
    options = {}
  ) {
    const { statusCode, headers, result } = await requestModels(
      teamId,
      label,
      [modelSlug],
      options
    )

    return {
      statusCode,
      headers,
      result: { ...result, deployment: result.deployments?.[0] }
    }
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
      payload: { modelSlugs: ['gpt-4o'], environment: 'sandbox' }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('entra-identity-required')
  })

  test('POST /v1/teams/{teamId}/deployments requests a deployment for an active team member', async () => {
    const teamId = await createTeam('deploy-user-1')

    const { result, statusCode, headers } = await requestModel(
      teamId,
      'deploy-user-1'
    )

    expect(statusCode).toBe(201)
    expect(headers.location).toBe(`/v1/teams/${teamId}/deployments`)
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
    const { result, statusCode } = await requestModel(
      teamId,
      'deploy-user-2',
      'gpt-4o',
      { environment: 'infradev' }
    )

    expect(statusCode).toBe(403)
    expect(result.code).toBe('environment-not-available')
  })

  test('POST /v1/teams/{teamId}/deployments rejects an environment that is not a registry name', async () => {
    const teamId = await createTeam('deploy-user-2b')

    const { statusCode } = await requestModel(
      teamId,
      'deploy-user-2b',
      'gpt-4o',
      { environment: 'Infra Dev' }
    )

    expect(statusCode).toBe(400)
  })

  test('POST /v1/teams/{teamId}/deployments rejects a model without the team tier', async () => {
    const teamId = await createTeam('deploy-user-3')

    const { result, statusCode } = await requestModel(
      teamId,
      'deploy-user-3',
      'gpt-5-nano'
    )

    expect(statusCode).toBe(403)
    expect(result.code).toBe('model-not-eligible')
    expect(result.modelSlugs).toEqual(['gpt-5-nano'])
  })

  test('POST /v1/teams/{teamId}/deployments returns 404 for a non-member', async () => {
    const teamId = await createTeam('deploy-user-4')

    const { statusCode } = await requestModel(teamId, 'someone-else')

    expect(statusCode).toBe(404)
  })

  test('POST /v1/teams/{teamId}/deployments rejects a duplicate request with a link to the existing one', async () => {
    const teamId = await createTeam('deploy-user-5')

    const first = await requestModel(teamId, 'deploy-user-5')

    const { result, statusCode } = await requestModel(teamId, 'deploy-user-5')

    expect(statusCode).toBe(409)
    expect(result.code).toBe('deployment-exists')
    expect(result.existingId).toBe(first.result.deployment._id.toString())
    expect(result.existing).toEqual([
      { id: first.result.deployment._id.toString(), modelSlug: 'gpt-4o' }
    ])
  })

  test('POST /v1/teams/{teamId}/deployments extends the same team+environment document with a second model', async () => {
    const teamId = await createTeam('deploy-user-16')

    const first = await requestModel(teamId, 'deploy-user-16')

    const second = await requestModel(teamId, 'deploy-user-16', 'gpt-4-1-nano')

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
    const request = () =>
      server.inject({
        method: 'POST',
        url: `/v1/teams/${teamId}/deployments`,
        headers,
        payload: { modelSlugs: ['gpt-4o'], environment: 'sandbox' }
      })

    const first = await request()
    const { result, statusCode } = await request()

    expect(statusCode).toBe(201)
    expect(result.deployments[0]._id.toString()).toBe(
      first.result.deployments[0]._id.toString()
    )
  })

  test('POST /v1/teams/{teamId}/deployments requires an idempotency key', async () => {
    const teamId = await createTeam('deploy-user-14')

    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: userHeaders('deploy-user-14'),
      payload: { modelSlugs: ['gpt-4o'], environment: 'sandbox' }
    })

    expect(statusCode).toBe(400)
  })

  describe('requesting several models at once', () => {
    const BOTH = ['gpt-4o', 'gpt-4-1-nano']

    test('makes one deployment per model in the order asked: the first in flight, the rest queued', async () => {
      const teamId = await createTeam('multi-user-1')

      const { result, statusCode } = await requestModels(
        teamId,
        'multi-user-1',
        BOTH
      )

      expect(statusCode).toBe(201)
      expect(
        result.deployments.map(({ modelSlug, status }) => [modelSlug, status])
      ).toEqual([
        ['gpt-4o', 'requested'],
        ['gpt-4-1-nano', 'queued']
      ])
      expect(
        new Set(result.deployments.map((entry) => entry.operationId)).size
      ).toBe(2)
    })

    test('replays every deployment of a repeated idempotency key, without making more', async () => {
      const teamId = await createTeam('multi-user-2')
      const headers = postHeaders('multi-user-2')
      const request = () =>
        server.inject({
          method: 'POST',
          url: `/v1/teams/${teamId}/deployments`,
          headers,
          payload: { modelSlugs: BOTH, environment: 'sandbox' }
        })

      const first = await request()
      const replay = await request()

      expect(replay.statusCode).toBe(201)
      expect(replay.result.deployments.map((entry) => entry._id)).toEqual(
        first.result.deployments.map((entry) => entry._id)
      )

      const stored = await server.db
        .collection('teamDeployments')
        .findOne({ teamId: teamId.toString() })

      expect(stored.deployments).toHaveLength(2)
    })

    test('finishes the models a half-made request did not reach when its key is replayed', async () => {
      const teamId = await createTeam('multi-user-3')
      const headers = postHeaders('multi-user-3')
      const request = (modelSlugs) =>
        server.inject({
          method: 'POST',
          url: `/v1/teams/${teamId}/deployments`,
          headers,
          payload: { modelSlugs, environment: 'sandbox' }
        })

      const partial = await request(['gpt-4o'])
      const whole = await request(BOTH)

      expect(whole.result.deployments.map((entry) => entry.modelSlug)).toEqual(
        BOTH
      )
      expect(whole.result.deployments[0]._id).toBe(
        partial.result.deployments[0]._id
      )
    })

    test('refuses the whole request, creating nothing, when one model is not eligible', async () => {
      const teamId = await createTeam('multi-user-4')

      const { result, statusCode } = await requestModels(
        teamId,
        'multi-user-4',
        ['gpt-4o', 'gpt-5-nano']
      )

      expect(statusCode).toBe(403)
      expect(result.code).toBe('model-not-eligible')
      expect(result.modelSlugs).toEqual(['gpt-5-nano'])
      expect(
        await server.db
          .collection('teamDeployments')
          .findOne({ teamId: teamId.toString() })
      ).toBeNull()
    })

    test('refuses the whole request, creating nothing, when the team already has one of the models', async () => {
      const teamId = await createTeam('multi-user-5')
      const existing = await requestModel(teamId, 'multi-user-5', 'gpt-4o')

      const { result, statusCode } = await requestModels(
        teamId,
        'multi-user-5',
        BOTH
      )

      expect(statusCode).toBe(409)
      expect(result.code).toBe('deployment-exists')
      expect(result.existing).toEqual([
        { id: existing.result.deployment._id, modelSlug: 'gpt-4o' }
      ])

      const stored = await server.db
        .collection('teamDeployments')
        .findOne({ teamId: teamId.toString() })

      expect(stored.deployments).toHaveLength(1)
    })

    test('lets a team ask again for a model it has removed', async () => {
      const teamId = await createTeam('multi-user-6')
      const first = await requestModel(teamId, 'multi-user-6')
      const url = `/v1/teams/${teamId}/deployments/${first.result.deployment._id}`

      await wait(300)
      await server.inject({
        method: 'GET',
        url,
        headers: userHeaders('multi-user-6')
      })
      await server.inject({
        method: 'DELETE',
        url,
        headers: userHeaders('multi-user-6')
      })

      const again = await requestModel(teamId, 'multi-user-6')

      expect(again.statusCode).toBe(201)
      expect(again.result.deployment._id).not.toBe(first.result.deployment._id)
    })

    test.each([
      ['no models', []],
      ['the same model twice', ['gpt-4o', 'gpt-4o']],
      [
        'more models than a team file holds',
        Array.from({ length: 21 }, (_, index) => `model-${index}`)
      ],
      ['a name that is not a slug', ['GPT 4o']]
    ])('rejects %s', async (_name, modelSlugs) => {
      const label = `multi-invalid-${randomUUID().slice(-8)}`
      const teamId = await createTeam(label)

      const { statusCode } = await requestModels(teamId, label, modelSlugs)

      expect(statusCode).toBe(400)
    })

    test('rejects the old single-model body', async () => {
      const teamId = await createTeam('multi-user-8')

      const { statusCode } = await server.inject({
        method: 'POST',
        url: `/v1/teams/${teamId}/deployments`,
        headers: postHeaders('multi-user-8'),
        payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
      })

      expect(statusCode).toBe(400)
    })
  })

  test('GET /v1/teams/{teamId}/deployments/{id} progresses through the GitOps states to active', async () => {
    const teamId = await createTeam('deploy-user-6')

    const created = await requestModel(teamId, 'deploy-user-6')

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

    const created = await requestModel(teamId, 'deploy-user-6b')

    expect(
      created.result.deployment.progressSteps.map((step) => step.label)
    ).toEqual([
      'Request recorded',
      'Team checked',
      'Setting up access in Azure',
      'Preparing your client secret'
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
    ).toEqual(['done', 'done', 'done', 'done'])
  })

  test('GET /v1/teams/{teamId}/deployments/{id} has no progress steps for a failed deployment', async () => {
    const teamId = await createTeam('test-checks-fail-6c')

    const created = await requestModel(teamId, 'test-checks-fail-6c')

    const url = `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`
    const headers = userHeaders('test-checks-fail-6c')

    await wait(300)

    const { result } = await server.inject({ method: 'GET', url, headers })

    expect(result.deployment.status).toBe('checks-failed')
    expect(result.deployment.progressSteps).toBeNull()
  })

  test('GET /v1/teams/{teamId}/deployments/{id} returns 404 for a non-member', async () => {
    const teamId = await createTeam('deploy-user-7')

    const created = await requestModel(teamId, 'deploy-user-7')

    const { statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`,
      headers: userHeaders('someone-else')
    })

    expect(statusCode).toBe(404)
  })

  test('GET /v1/teams/{teamId}/deployments/{id} lands on checks-failed for the reserved test prefix', async () => {
    const teamId = await createTeam('test-checks-fail-8')

    const created = await requestModel(teamId, 'test-checks-fail-8')

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

    const created = await requestModel(teamId, 'test-deploy-fail-9')

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

    const created = await requestModel(teamId, 'deploy-user-10')

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

    await requestModel(teamId, 'deploy-user-11')

    const { statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments`,
      headers: userHeaders('someone-else')
    })

    expect(statusCode).toBe(404)
  })

  test('a second request waits as queued behind the one in flight, then is dispatched once that ends', async () => {
    const teamId = await createTeam('deploy-user-18')

    await requestModel(teamId, 'deploy-user-18')

    const queued = await requestModel(teamId, 'deploy-user-18', 'gpt-4-1-nano')

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

    await requestModel(teamId, 'deploy-user-12')

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

    const created = await requestModel(teamId, 'deploy-user-15')

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
      const created = await requestModel(teamId, label)
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
      const created = await requestModel(teamId, 'remove-user-2')

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
