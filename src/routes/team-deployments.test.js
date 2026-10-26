import { randomUUID } from 'node:crypto'

const ENTRA_TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'
// The mock orchestrator's reserved requester ranges, by test name prefix.
const FORCED_FAILURE_OID_RANGES = {
  'test-checks-fail-': '00000000-0000-0000-0001-',
  'test-deploy-fail-': '00000000-0000-0000-0002-'
}

// The mock orchestrator sends its events in the background; this waits until
// it has sent every event it has been given (the argument is not a duration).
let settleEvents

function wait() {
  return settleEvents()
}

describe('#team-deployments routes', () => {
  let server
  let invalidateModelsCache

  beforeAll(async () => {
    // Short mock stage duration so the "being set up" progression can be polled
    // in real time within a test without waiting on the production default.
    vi.stubEnv('TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS', '30')

    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    ;({ invalidateModelsCache } = await import('#/services/models-service.js'))
    server = await createServer()
    await server.initialize()
    settleEvents = () => server.app.operations.transport.worker.idle()
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
    // The mock orchestrator has no GitHub runs to link to yet.
    expect(result.deployment.links).toEqual({})

    const stored = await server.db
      .collection('teamDeployments')
      .findOne({ teamId: teamId.toString() })

    expect(stored.deployments[0]).toMatchObject({
      operationId: result.deployment.operationId,
      operation: { id: result.deployment.operationId, state: 'requested' }
    })
    expect(stored.deployments[0]).not.toHaveProperty('gitops')
    expect(stored.deployments[0]).not.toHaveProperty('orchestrator')
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

    expect(statusCode).toBe(400)
    expect(result.code).toBe('model-not-eligible')
    expect(result.modelSlugs).toEqual(['gpt-5-nano'])
  })

  describe('team eligibility', () => {
    async function memberOf(teamId, label, role) {
      await signIn(label)
      await server.db.collection('teamMembers').insertOne({
        teamId: teamId.toString(),
        userId: userIds.get(label),
        role,
        status: 'active'
      })
    }

    async function storedDeployments(teamId) {
      return server.db
        .collection('teamDeployments')
        .findOne({ teamId: teamId.toString() })
    }

    test.each([
      ['a team admin', 'admin'],
      ['a team member', 'user']
    ])(
      'refuses a model whose team SKU is in East US for %s, writing nothing',
      async (_who, role) => {
        const owner = `eligibility-owner-${role}`
        const teamId = await createTeam(owner)
        const label = `eligibility-${role}`
        const slug = `gpt-4o-east-us-${role}`
        const gpt4o = await server.db
          .collection('models')
          .findOne({ slug: 'gpt-4o' }, { projection: { _id: 0 } })

        await memberOf(teamId, label, role)
        await server.db.collection('models').insertOne({
          ...gpt4o,
          slug,
          skus: [{ name: 'Standard', tiers: ['team'], regions: ['eastus'] }]
        })
        invalidateModelsCache()

        const { result, statusCode } = await requestModel(teamId, label, slug)

        expect(statusCode).toBe(400)
        expect(result).toMatchObject({
          code: 'model-not-eligible',
          message: 'Model is not eligible for this environment',
          modelSlugs: [slug]
        })
        expect(await storedDeployments(teamId)).toBeNull()
      }
    )

    test.each([
      ['a team admin', 'admin'],
      ['a team member', 'user']
    ])(
      'refuses a model whose only team SKU is GlobalStandard for %s, writing nothing',
      async (_who, role) => {
        const owner = `eligibility-global-owner-${role}`
        const teamId = await createTeam(owner)
        const label = `eligibility-global-${role}`
        const slug = `gpt-4o-global-${role}`
        const gpt4o = await server.db
          .collection('models')
          .findOne({ slug: 'gpt-4o' }, { projection: { _id: 0 } })

        await memberOf(teamId, label, role)
        await server.db.collection('models').insertOne({
          ...gpt4o,
          slug,
          skus: [
            { name: 'GlobalStandard', tiers: ['team'], regions: ['uksouth'] }
          ]
        })
        invalidateModelsCache()

        const { result, statusCode } = await requestModel(teamId, label, slug)

        expect(statusCode).toBe(400)
        expect(result.code).toBe('model-not-eligible')
        expect(await storedDeployments(teamId)).toBeNull()
      }
    )

    test.each([
      ['a team admin', 'admin'],
      ['a team member', 'user']
    ])(
      'offers GPT-4.1 nano (team SKU in Sweden Central) to %s',
      async (_who, role) => {
        const owner = `eligibility-nano-owner-${role}`
        const teamId = await createTeam(owner)
        const label = `eligibility-nano-${role}`

        await memberOf(teamId, label, role)

        const { result, statusCode } = await requestModel(
          teamId,
          label,
          'gpt-4-1-nano'
        )

        expect(statusCode).toBe(201)
        expect(result.deployment.modelSlug).toBe('gpt-4-1-nano')
      }
    )

    test.each([
      ['a team admin', 'admin'],
      ['a team member', 'user']
    ])('offers GPT-4o to %s', async (_who, role) => {
      const owner = `eligibility-gpt4o-owner-${role}`
      const teamId = await createTeam(owner)
      const label = `eligibility-gpt4o-${role}`

      await memberOf(teamId, label, role)

      const { result, statusCode } = await requestModel(teamId, label, 'gpt-4o')

      expect(statusCode).toBe(201)
      expect(result.deployment.modelSlug).toBe('gpt-4o')
    })

    test('refuses a model whose catalogue environments lack the target before writing anything', async () => {
      const teamId = await createTeam('eligibility-other-env')
      const gpt4o = await server.db
        .collection('models')
        .findOne({ slug: 'gpt-4o' }, { projection: { _id: 0 } })

      await server.db
        .collection('models')
        .insertOne({ ...gpt4o, slug: 'gpt-4o-qa-only', environments: ['qa'] })

      const { result, statusCode } = await requestModel(
        teamId,
        'eligibility-other-env',
        'gpt-4o-qa-only'
      )

      expect(statusCode).toBe(400)
      expect(result.code).toBe('model-not-eligible')
      expect(result.modelSlugs).toEqual(['gpt-4o-qa-only'])
      expect(await storedDeployments(teamId)).toBeNull()
    })

    test('refuses a non-member before looking at the model', async () => {
      const teamId = await createTeam('eligibility-owner-outsider')

      const { statusCode } = await requestModel(
        teamId,
        'eligibility-outsider',
        'gpt-4-1-nano'
      )

      expect(statusCode).toBe(404)
      expect(await storedDeployments(teamId)).toBeNull()
    })
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

    const second = await requestModel(teamId, 'deploy-user-16', 'gpt-5-mini')

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
      'gpt-4o',
      'gpt-5-mini'
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
    const BOTH = ['gpt-4o', 'gpt-5-mini']

    test('makes one deployment per model in the order asked, all in one operation', async () => {
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
        ['gpt-5-mini', 'requested']
      ])
      expect(
        new Set(result.deployments.map((entry) => entry.operationId)).size
      ).toBe(1)
      expect(
        await server.db
          .collection('operations')
          .countDocuments({ teamId: teamId.toString() })
      ).toBe(1)
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

    test('refuses a repeated idempotency key used for other models, creating nothing more', async () => {
      const teamId = await createTeam('multi-user-3')
      const headers = postHeaders('multi-user-3')
      const request = (modelSlugs) =>
        server.inject({
          method: 'POST',
          url: `/v1/teams/${teamId}/deployments`,
          headers,
          payload: { modelSlugs, environment: 'sandbox' }
        })

      await request(['gpt-4o'])

      const other = await request(BOTH)

      expect(other.statusCode).toBe(409)
      expect(other.result.code).toBe('idempotency-key-reused')

      const stored = await server.db
        .collection('teamDeployments')
        .findOne({ teamId: teamId.toString() })

      expect(stored.deployments.map((entry) => entry.modelSlug)).toEqual([
        'gpt-4o'
      ])
    })

    test('refuses the whole request, creating nothing, when one model is not eligible', async () => {
      const teamId = await createTeam('multi-user-4')

      const { result, statusCode } = await requestModels(
        teamId,
        'multi-user-4',
        ['gpt-4o', 'gpt-5-nano']
      )

      expect(statusCode).toBe(400)
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

      await wait()
      await server.inject({
        method: 'DELETE',
        url,
        headers: userHeaders('multi-user-6')
      })
      await wait()

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

    await wait()

    const second = await server.inject({ method: 'GET', url, headers })

    expect(second.result.deployment.status).toBe('active')
    expect(second.result.deployment.activatedAt).toBeTruthy()
  })

  test('GET /v1/teams/{teamId}/deployments/{id} exposes the five progress steps, naming the model, with their times', async () => {
    const teamId = await createTeam('deploy-user-6b')

    const created = await requestModel(teamId, 'deploy-user-6b')
    const isoTime = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)

    expect(created.result.deployment.progressSteps).toEqual([
      { label: 'Request recorded', state: 'current', at: isoTime },
      { label: 'Change committed', state: 'pending', at: null },
      { label: 'Setting up GPT-4o in Azure', state: 'pending', at: null },
      {
        label: 'Checking your resources in Azure',
        state: 'pending',
        at: null
      },
      { label: 'Preparing your client secret', state: 'pending', at: null }
    ])

    const url = `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`
    const headers = userHeaders('deploy-user-6b')

    await wait()

    const afterActive = await server.inject({ method: 'GET', url, headers })
    const steps = afterActive.result.deployment.progressSteps

    expect(afterActive.result.deployment.status).toBe('active')
    expect(steps.map((step) => step.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done'
    ])
    expect(steps.map((step) => step.at)).toEqual([
      isoTime,
      isoTime,
      isoTime,
      isoTime,
      isoTime
    ])
    expect(steps.at(-1).at).toBe(afterActive.result.deployment.activatedAt)
  })

  test('GET /v1/teams/{teamId}/deployments/{id} has no progress steps for a failed deployment', async () => {
    const teamId = await createTeam('test-checks-fail-6c')

    const created = await requestModel(teamId, 'test-checks-fail-6c')

    const url = `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`
    const headers = userHeaders('test-checks-fail-6c')

    await wait()

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

    await wait()

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

    await wait()

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

  test('a second request waits as queued behind the one in flight, then is submitted once that ends and goes on to active', async () => {
    const teamId = await createTeam('deploy-user-18')

    await requestModel(teamId, 'deploy-user-18')

    const queued = await requestModel(teamId, 'deploy-user-18', 'gpt-5-mini')

    expect(queued.statusCode).toBe(201)
    expect(queued.result.deployment.status).toBe('queued')

    const url = `/v1/teams/${teamId}/deployments/${queued.result.deployment._id}`

    // The first operation ending frees the file for the waiting one.
    await wait()

    const submitted = await server.inject({
      method: 'GET',
      url,
      headers: userHeaders('deploy-user-18')
    })

    expect(submitted.result.deployment.status).toBe('active')
  })

  test('GET /v1/teams/{teamId}/deployments reflects refreshed status', async () => {
    const teamId = await createTeam('deploy-user-12')

    await requestModel(teamId, 'deploy-user-12')

    await wait()

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}/deployments`,
      headers: userHeaders('deploy-user-12')
    })

    expect(result.items[0].status).toBe('active')
  })

  // B28 characterisation (plan 6.2, "unchanged route payloads"): the keys of a
  // deployment and of each response envelope, so a refactor that moves the
  // orchestration cannot change a payload the frontend reads by accident.
  describe('payload shape', () => {
    const DEPLOYMENT_KEYS = [
      '_id',
      'activatedAt',
      'appRegistration',
      'createdAt',
      'credentialPlaceholder',
      'environment',
      'failureReason',
      'idempotencyKey',
      'links',
      'modelSlug',
      'operation',
      'operationId',
      'progressSteps',
      'removedAt',
      'requestedBy',
      'resources',
      'status',
      'teamId',
      'verificationFailure'
    ]

    test('the request, read and list responses carry the same deployment keys in the same envelopes', async () => {
      const teamId = await createTeam('shape-user-1')
      const created = await requestModel(teamId, 'shape-user-1')
      const url = `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`
      const headers = userHeaders('shape-user-1')

      const read = await server.inject({ method: 'GET', url, headers })
      const list = await server.inject({
        method: 'GET',
        url: `/v1/teams/${teamId}/deployments`,
        headers
      })

      expect(Object.keys(created.result)).toEqual(['deployments', 'deployment'])
      expect(Object.keys(created.result.deployment).sort()).toEqual(
        DEPLOYMENT_KEYS
      )
      expect(Object.keys(read.result)).toEqual(['deployment'])
      expect(Object.keys(read.result.deployment).sort()).toEqual(
        DEPLOYMENT_KEYS
      )
      expect(Object.keys(list.result)).toEqual(['items'])
      expect(Object.keys(list.result.items[0]).sort()).toEqual(DEPLOYMENT_KEYS)
    })
  })

  describe('DELETE /v1/teams/{teamId}/deployments/{id}', () => {
    async function activeDeployment(label) {
      const teamId = await createTeam(label)
      const created = await requestModel(teamId, label)
      const url = `/v1/teams/${teamId}/deployments/${created.result.deployment._id}`

      await wait()

      return { teamId, url }
    }

    test('accepts the removal of an active model for a team admin, then withdraws its grant once it has applied', async () => {
      const { teamId, url } = await activeDeployment('remove-user-1')

      const { result, statusCode } = await server.inject({
        method: 'DELETE',
        url,
        headers: userHeaders('remove-user-1')
      })

      expect(statusCode).toBe(202)
      expect(result.deployment).toMatchObject({
        status: 'removing',
        progressSteps: null,
        operation: { state: 'requested' }
      })

      await wait()

      const stored = await server.db
        .collection('teamDeployments')
        .findOne({ teamId: teamId.toString() })

      expect(stored.gateway.allowedDeployments).toEqual([])

      const listed = await server.inject({
        method: 'GET',
        url: `/v1/teams/${teamId}/deployments`,
        headers: userHeaders('remove-user-1')
      })

      expect(listed.result.items[0]).toMatchObject({
        status: 'removed',
        removedAt: expect.any(String),
        progressSteps: null
      })

      const again = await server.inject({
        method: 'DELETE',
        url,
        headers: userHeaders('remove-user-1')
      })

      expect(again.statusCode).toBe(200)
      expect(again.result.deployment.status).toBe('removed')
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

  describe('addressing the team by its slug', () => {
    async function slugOf(teamId) {
      const team = await server.db.collection('teams').findOne({ _id: teamId })

      return team.slug
    }

    test('requests, reads, lists and removes a deployment the same as by id', async () => {
      const label = 'slug-user-1'
      const teamId = await createTeam(label)
      const slug = await slugOf(teamId)

      const requested = await requestModel(slug, label)

      expect(requested.statusCode).toBe(201)
      expect(requested.headers.location).toBe(`/v1/teams/${slug}/deployments`)

      // Held against the team's id, so the slug and the id see one record.
      const stored = await server.db
        .collection('teamDeployments')
        .findOne({ teamId: teamId.toString() })

      expect(stored.deployments).toHaveLength(1)

      const byId = await requestModel(teamId, label)

      expect(byId.statusCode).toBe(409)
      expect(byId.result.code).toBe('deployment-exists')

      const deploymentUrl = `/v1/teams/${slug}/deployments/${requested.result.deployment._id}`
      const read = await server.inject({
        method: 'GET',
        url: deploymentUrl,
        headers: userHeaders(label)
      })
      const listed = await server.inject({
        method: 'GET',
        url: `/v1/teams/${slug}/deployments`,
        headers: userHeaders(label)
      })

      expect(read.statusCode).toBe(200)
      expect(listed.result.items).toHaveLength(1)

      await wait()

      const removed = await server.inject({
        method: 'DELETE',
        url: deploymentUrl,
        headers: userHeaders(label)
      })

      expect(removed.statusCode).toBe(202)
      expect(removed.result.deployment.status).toBe('removing')

      await wait()

      const done = await server.inject({
        method: 'GET',
        url: deploymentUrl,
        headers: userHeaders(label)
      })

      expect(done.result.deployment.status).toBe('removed')
    })

    test('keeps a person who is not in the team out, and a team member who is not an admin from removing', async () => {
      const label = 'slug-user-2'
      const teamId = await createTeam(label)
      const slug = await slugOf(teamId)
      const requested = await requestModel(slug, label)
      const deploymentUrl = `/v1/teams/${slug}/deployments/${requested.result.deployment._id}`

      await signIn('slug-member-2')
      await server.db.collection('teamMembers').insertOne({
        teamId: teamId.toString(),
        userId: userHeaders('slug-member-2')['x-user-id'],
        role: 'user',
        status: 'active'
      })

      const asMember = await server.inject({
        method: 'GET',
        url: `/v1/teams/${slug}/deployments`,
        headers: userHeaders('slug-member-2')
      })
      const memberRemoves = await server.inject({
        method: 'DELETE',
        url: deploymentUrl,
        headers: userHeaders('slug-member-2')
      })
      const stranger = userHeaders('slug-stranger-2')
      const strangerRequests = await requestModel(slug, 'slug-stranger-2')
      const strangerLists = await server.inject({
        method: 'GET',
        url: `/v1/teams/${slug}/deployments`,
        headers: stranger
      })
      const strangerReads = await server.inject({
        method: 'GET',
        url: deploymentUrl,
        headers: stranger
      })
      const strangerRemoves = await server.inject({
        method: 'DELETE',
        url: deploymentUrl,
        headers: stranger
      })

      expect(asMember.statusCode).toBe(200)
      expect(memberRemoves.statusCode).toBe(403)
      expect(memberRemoves.result.code).toBe('admin-required')
      expect(strangerRequests.statusCode).toBe(404)
      expect(strangerLists.statusCode).toBe(404)
      expect(strangerReads.statusCode).toBe(404)
      expect(strangerRemoves.statusCode).toBe(404)
    })

    test('is not found for a slug no team holds, as for an id no team holds', async () => {
      const label = 'slug-user-3'

      await signIn(label)

      const requested = await requestModel('no-such-team', label)
      const listed = await server.inject({
        method: 'GET',
        url: '/v1/teams/no-such-team/deployments',
        headers: userHeaders(label)
      })
      const read = await server.inject({
        method: 'GET',
        url: `/v1/teams/no-such-team/deployments/${randomUUID()}`,
        headers: userHeaders(label)
      })
      const removed = await server.inject({
        method: 'DELETE',
        url: `/v1/teams/no-such-team/deployments/${randomUUID()}`,
        headers: userHeaders(label)
      })

      expect(requested.statusCode).toBe(404)
      expect(listed.statusCode).toBe(404)
      expect(read.statusCode).toBe(404)
      expect(removed.statusCode).toBe(404)
    })
  })
})
