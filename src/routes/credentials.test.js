import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

const ENTRA_TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'

// The research models these tests issue keys for; the mock research file
// deploys only gpt-4o.
const DEPLOYED_FOR_RESEARCH = ['gpt-4o', 'gpt-5-nano', 'gpt-5-mini']

describe('#credentials routes', () => {
  let server
  let deployInResearch
  let failResearchRead
  let restoreResearchDeployments

  // The mock orchestrator sends its events in the background: this waits
  // until it has sent every one it has been given.
  function settled() {
    return server.app.operations.transport.worker.idle()
  }

  beforeAll(async () => {
    // Short mock stage duration so a team deployment can reach `active` in real
    // time within a test without waiting on the production default.
    vi.stubEnv('TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS', '30')

    // Dynamic imports needed due to config being updated by vitest-mongodb
    // and the env stub above (config snapshots the env on first import)
    ;({ deployInResearch, failResearchRead, restoreResearchDeployments } =
      await import('#/common/test-helpers/research-deployments.js'))
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    deployInResearch(DEPLOYED_FOR_RESEARCH)
  })

  afterAll(async () => {
    restoreResearchDeployments()
    await server.stop({ timeout: 0 })
    vi.unstubAllEnvs()
  })

  test('POST /v1/credentials issues a mock credential', async () => {
    const { result, statusCode, headers } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'user-1', 'idempotency-key': randomUUID() },
      payload: { modelSlug: 'gpt-4o' }
    })

    expect(statusCode).toBe(201)
    expect(headers.location).toBe(`/v1/credentials/${result.credential._id}`)
    expect(result.secret).toEqual(expect.stringContaining('mock_'))
    expect(result.credential.status).toBe('active')
    expect(result.credential.keyHint).toHaveLength(4)
    expect(result.credential).toMatchObject({
      provider: 'openai',
      offering: 'azure-openai',
      cloud: 'azure',
      gateway: 'azure-apim',
      issuerKey: 'mock'
    })
  })

  test('POST /v1/credentials records the research environment on the credential, defaulting to the configured one', async () => {
    const { result } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'env-user-1', 'idempotency-key': randomUUID() },
      payload: { modelSlug: 'gpt-4o' }
    })

    expect(result.credential.environment).toBe('infradev')
  })

  test('POST /v1/credentials refuses a research environment this instance is not configured for', async () => {
    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'env-user-2', 'idempotency-key': randomUUID() },
      payload: { modelSlug: 'gpt-4o', environment: 'sandbox' }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('environment-not-available')
  })

  test('POST /v1/credentials rejects an environment that is not an environment name', async () => {
    const { statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'env-user-3', 'idempotency-key': randomUUID() },
      payload: { modelSlug: 'gpt-4o', environment: 'Infra Dev' }
    })

    expect(statusCode).toBe(400)
  })

  test('POST /v1/credentials replays without a secret for a repeated Idempotency-Key', async () => {
    const idempotencyKey = randomUUID()
    const headers = { 'x-user-id': 'user-2', 'idempotency-key': idempotencyKey }
    const payload = { modelSlug: 'gpt-5-nano' }

    const first = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload
    })
    const second = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload
    })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)
    expect(second.result.secret).toBeUndefined()
  })

  test('POST /v1/credentials rejects a second active credential for the same model', async () => {
    const headers = { 'x-user-id': 'user-3', 'idempotency-key': randomUUID() }
    const payload = { modelSlug: 'gpt-5-mini' }

    await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload
    })

    expect(statusCode).toBe(409)
    expect(result.code).toBe('active-credential-exists')
  })

  test('POST /v1/credentials rejects re-issuing for a model with an expired credential, pointing to renew', async () => {
    const headers = {
      'x-user-id': 'user-expired',
      'idempotency-key': randomUUID()
    }
    const payload = { modelSlug: 'gpt-5-mini' }

    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload
    })

    await server.db
      .collection('credentials')
      .updateOne(
        { _id: new ObjectId(issued.result.credential._id) },
        { $set: { status: 'expired' } }
      )

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload
    })

    expect(statusCode).toBe(409)
    expect(result.code).toBe('credential-expired-use-renew')
  })

  test.each([
    ['an expired', { status: 'expired', environment: 'sandbox' }],
    ['an active', { status: 'active', environment: 'sandbox' }],
    ['a legacy expired', { status: 'expired' }]
  ])(
    'POST /v1/credentials issues into the configured environment past %s key left in the sandbox',
    async (_label, old) => {
      const userId = `user-moved-${randomUUID()}`

      await server.db.collection('credentials').insertOne({
        userId,
        modelSlug: 'gpt-5-mini',
        tier: 'research',
        type: 'apim-subscription',
        createdAt: new Date().toISOString(),
        ...old
      })

      const { result, statusCode } = await server.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
        payload: { modelSlug: 'gpt-5-mini' }
      })

      expect(statusCode).toBe(201)
      expect(result.credential.environment).toBe('infradev')
    }
  )

  test('POST /v1/credentials rejects a model that does not exist', async () => {
    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'user-4', 'idempotency-key': randomUUID() },
      payload: { modelSlug: 'not-a-real-model' }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('model-not-eligible')
  })

  describe('research eligibility (no Global, UK or EU only)', () => {
    async function insertResearchModel(slug, skus) {
      const gpt4o = await server.db
        .collection('models')
        .findOne({ slug: 'gpt-4o' }, { projection: { _id: 0 } })

      await server.db
        .collection('models')
        .insertOne({ ...gpt4o, slug, tiers: ['research'], skus })

      const { invalidateModelsCache } =
        await import('#/services/models-service.js')

      invalidateModelsCache()
    }

    function issue(modelSlug) {
      return server.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers: {
          'x-user-id': `research-rule-${randomUUID()}`,
          'idempotency-key': randomUUID()
        },
        payload: { modelSlug }
      })
    }

    test.each([
      [
        'GlobalStandard only',
        [{ name: 'GlobalStandard', tiers: ['research'], regions: ['uksouth'] }]
      ],
      [
        'a SKU in East US only',
        [{ name: 'Standard', tiers: ['research'], regions: ['eastus'] }]
      ],
      ['no SKU listing research', [{ name: 'Standard', tiers: ['team'] }]]
    ])('POST /v1/credentials refuses a model with %s', async (label, skus) => {
      const slug = `research-refused-${randomUUID().slice(0, 8)}`

      await insertResearchModel(slug, skus)

      const { result, statusCode } = await issue(slug)

      expect(statusCode).toBe(403)
      expect(result.code).toBe('model-not-eligible')
    })

    test('POST /v1/credentials still issues for an allowed DataZoneStandard SKU in Sweden Central', async () => {
      const slug = `research-sweden-${randomUUID().slice(0, 8)}`

      await insertResearchModel(slug, [
        { name: 'GlobalStandard', tiers: ['research'] },
        {
          name: 'DataZoneStandard',
          tiers: ['research', 'team'],
          regions: ['swedencentral']
        }
      ])
      deployInResearch([...DEPLOYED_FOR_RESEARCH, slug])

      const { statusCode } = await issue(slug)

      expect(statusCode).toBe(201)
    })

    test('POST /v1/credentials refuses a catalogue-eligible model research has not deployed, creating no credential', async () => {
      const userId = `research-undeployed-${randomUUID()}`

      const { result, statusCode } = await server.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
        payload: { modelSlug: 'gpt-4-1-nano' }
      })

      expect(statusCode).toBe(403)
      expect(result.code).toBe('model-not-deployed')
      expect(
        await server.db.collection('credentials').countDocuments({ userId })
      ).toBe(0)
    })

    test('POST /v1/credentials refuses with 502 when the deployed models cannot be read', async () => {
      failResearchRead()

      const { result, statusCode } = await server.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers: {
          'x-user-id': `research-unreadable-${randomUUID()}`,
          'idempotency-key': randomUUID()
        },
        payload: { modelSlug: 'gpt-4o' }
      })

      deployInResearch(DEPLOYED_FOR_RESEARCH)

      expect(statusCode).toBe(502)
      expect(result.code).toBe('research-deployments-unavailable')
    })
  })

  test('POST /v1/credentials persists an optional purpose', async () => {
    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'user-purpose', 'idempotency-key': randomUUID() },
      payload: { modelSlug: 'gpt-4o', purpose: 'Evaluating for a pilot' }
    })

    expect(statusCode).toBe(201)
    expect(result.credential.purpose).toBe('Evaluating for a pilot')
  })

  test('POST /v1/credentials returns 502 upstream-unavailable when the issuer fails', async () => {
    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: {
        'x-user-id': 'test-fail-user',
        'idempotency-key': randomUUID()
      },
      payload: { modelSlug: 'gpt-4o' }
    })

    expect(statusCode).toBe(502)
    expect(result.code).toBe('upstream-unavailable')

    const { result: listResult } = await server.inject({
      method: 'GET',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'test-fail-user' }
    })

    expect(listResult.items[0].status).toBe('failed')
    expect(listResult.items[0].failureReason).toBe('issuer-error')
  })

  test('POST /v1/credentials retrying after a failed issue reuses the same credential document rather than creating another one', async () => {
    const userId = `test-fail-user-${randomUUID()}`
    const payload = { modelSlug: 'gpt-4o' }

    const first = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
      payload
    })

    const second = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
      payload
    })

    expect(first.statusCode).toBe(502)
    expect(second.statusCode).toBe(502)

    const { result: listResult } = await server.inject({
      method: 'GET',
      url: '/v1/credentials',
      headers: { 'x-user-id': userId }
    })

    expect(listResult.items).toHaveLength(1)
    expect(listResult.items[0].status).toBe('failed')
  })

  test('POST /v1/credentials issued concurrently for the same user and model still collapses to one credential document', async () => {
    const userId = `test-fail-user-${randomUUID()}`
    const payload = { modelSlug: 'gpt-4o' }

    const [first, second] = await Promise.all([
      server.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
        payload
      }),
      server.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
        payload
      })
    ])

    expect(first.statusCode).toBe(502)
    expect(second.statusCode).toBe(502)

    const { result: listResult } = await server.inject({
      method: 'GET',
      url: '/v1/credentials',
      headers: { 'x-user-id': userId }
    })

    expect(listResult.items).toHaveLength(1)
  })

  test('POST /v1/credentials requires an Idempotency-Key header', async () => {
    const { statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'user-5' },
      payload: { modelSlug: 'gpt-4o' }
    })

    expect(statusCode).toBe(400)
  })

  test("GET /v1/credentials lists a user's own credentials without secrets", async () => {
    const headers = { 'x-user-id': 'user-6', 'idempotency-key': randomUUID() }

    await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })

    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/credentials',
      headers: { 'x-user-id': 'user-6' }
    })

    expect(statusCode).toBe(200)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].secret).toBeUndefined()
    expect(result.items[0].renewalsRemaining).toBe(3)
  })

  test("GET /v1/credentials/{id} returns 404 for another user's credential", async () => {
    const headers = { 'x-user-id': 'user-7', 'idempotency-key': randomUUID() }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })

    const { statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/credentials/${issued.result.credential._id}`,
      headers: { 'x-user-id': 'someone-else' }
    })

    expect(statusCode).toBe(404)
  })

  test('GET /v1/credentials/{id} allows another active team member to view a shared team credential', async () => {
    const teamId = await createTeamWithActiveDeployment('team-cred-view-1')
    const credential = await teamCredentialOf(teamId)

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/members`,
      headers: {
        'x-user-id': 'team-cred-view-1',
        'idempotency-key': randomUUID()
      },
      payload: { email: 'viewer-teammate@defra.gov.uk' }
    })

    const signIn = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: randomUUID(),
        tid: ENTRA_TENANT_ID,
        email: 'viewer-teammate@defra.gov.uk',
        displayName: 'Viewer Teammate'
      }
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/v1/credentials/${credential._id}`,
      headers: { 'x-user-id': signIn.result.user._id.toString() }
    })

    expect(statusCode).toBe(200)
    expect(result.secret).toBeUndefined()
    expect(result.teamId).toBe(teamId)
  })

  test('a teammate cannot view or list another member\u2019s personal research credential', async () => {
    const teamId = await createTeamWithActiveDeployment('team-cred-leak-1')

    // A research credential issued by the team admin still persists their
    // teamId, so it must not surface to teammates as a shared credential.
    const personal = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: {
        'x-user-id': 'team-cred-leak-1',
        'idempotency-key': randomUUID()
      },
      payload: { modelSlug: 'gpt-5-nano' }
    })

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/members`,
      headers: {
        'x-user-id': 'team-cred-leak-1',
        'idempotency-key': randomUUID()
      },
      payload: { email: 'leak-teammate@defra.gov.uk' }
    })

    const signIn = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: randomUUID(),
        tid: ENTRA_TENANT_ID,
        email: 'leak-teammate@defra.gov.uk',
        displayName: 'Leak Teammate'
      }
    })

    const teammateId = signIn.result.user._id.toString()

    const viewed = await server.inject({
      method: 'GET',
      url: `/v1/credentials/${personal.result.credential._id}`,
      headers: { 'x-user-id': teammateId }
    })

    expect(viewed.statusCode).toBe(404)

    const listed = await server.inject({
      method: 'GET',
      url: '/v1/credentials',
      headers: { 'x-user-id': teammateId }
    })

    expect(
      listed.result.items.some(
        (item) =>
          item._id.toString() === personal.result.credential._id.toString()
      )
    ).toBe(false)
  })

  test('POST /v1/credentials/{id}/renew extends expiry and increments renewalCount', async () => {
    const headers = { 'x-user-id': 'user-8', 'idempotency-key': randomUUID() }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${issued.result.credential._id}/renew`,
      headers: { 'x-user-id': 'user-8' }
    })

    expect(statusCode).toBe(200)
    expect(result.renewalCount).toBe(1)
    expect(result.renewalsRemaining).toBe(2)
  })

  test('POST /v1/credentials/{id}/renew rejects once the renewal cap is reached', async () => {
    const headers = { 'x-user-id': 'user-9', 'idempotency-key': randomUUID() }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })
    const id = issued.result.credential._id

    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: 'POST',
        url: `/v1/credentials/${id}/renew`,
        headers: { 'x-user-id': 'user-9' }
      })
    }

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${id}/renew`,
      headers: { 'x-user-id': 'user-9' }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('renewal-cap-reached')
  })

  test('POST /v1/credentials/{id}/renew rejects a team tier credential as non-renewable', async () => {
    const teamId = await createTeamWithActiveDeployment('team-cred-renew-1')
    const credential = await teamCredentialOf(teamId)

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${credential._id}/renew`,
      headers: { 'x-user-id': credential.userId }
    })

    expect(statusCode).toBe(400)
    expect(result.code).toBe('team-credential-no-renewal')
  })

  test('DELETE /v1/credentials/{id} revokes the credential', async () => {
    const headers = { 'x-user-id': 'user-10', 'idempotency-key': randomUUID() }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })
    const id = issued.result.credential._id

    const revoke = await server.inject({
      method: 'DELETE',
      url: `/v1/credentials/${id}`,
      headers: { 'x-user-id': 'user-10' }
    })

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/credentials/${id}`,
      headers: { 'x-user-id': 'user-10' }
    })

    expect(revoke.statusCode).toBe(204)
    expect(result.status).toBe('revoked')
  })

  test('DELETE /v1/credentials/{id} returns 404 for an unknown id', async () => {
    const { statusCode } = await server.inject({
      method: 'DELETE',
      url: '/v1/credentials/507f1f77bcf86cd799439011',
      headers: { 'x-user-id': 'user-11' }
    })

    expect(statusCode).toBe(404)
  })

  async function createTeamWithActiveDeployment(userId, modelSlug = 'gpt-4o') {
    const team = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: { 'x-user-id': userId, 'idempotency-key': randomUUID() },
      payload: { name: `Team ${userId}`, serviceCode: 'ABC' }
    })
    const teamId = team.result.team._id.toString()
    // A deployment request is attributed to the requester's Entra object ID,
    // so a signed-in member requests it; `userId` stays the team admin.
    const requesterId = await inviteAndSignIn(
      teamId,
      userId,
      `${userId}-requester@defra.gov.uk`,
      'Deployment Requester'
    )

    await requestActiveDeployment(teamId, requesterId, modelSlug)

    return teamId
  }

  async function requestActiveDeployment(teamId, requesterId, modelSlug) {
    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: { 'x-user-id': requesterId, 'idempotency-key': randomUUID() },
      payload: { modelSlugs: [modelSlug], environment: 'sandbox' }
    })

    await settled()
  }

  // Nobody receives a team secret from a request: it goes to the vault when a
  // deployment turns active, and an admin reveals it with a reason.
  async function teamCredentialOf(teamId, environment = 'sandbox') {
    return server.db
      .collection('credentials')
      .findOne({ teamId, environment, tier: 'team' })
  }

  async function activeTeamCredentials(teamId, environment = 'sandbox') {
    return server.db
      .collection('credentials')
      .find({ teamId, environment, tier: 'team', status: 'active' })
      .toArray()
  }

  test('a deployment turning active creates the team credential, its secret in the vault and never returned', async () => {
    const adminId = 'team-cred-user-1'
    const teamId = await createTeamWithActiveDeployment(adminId)

    const credential = await teamCredentialOf(teamId)

    expect(credential).toMatchObject({
      tier: 'team',
      teamId,
      environment: 'sandbox',
      status: 'active',
      // The team tier is OAuth only.
      credentialType: 'oauth',
      // Shared per team+environment, never per model or per requesting member.
      externalGatewaySubscriptionId: `team-${teamId}-sandbox`,
      // A team credential spans models, so it keeps cloud/gateway but no
      // single provider/offering, and never expires.
      provider: null,
      offering: null,
      cloud: 'azure',
      gateway: 'azure-apim',
      expiresAt: null
    })
    expect(credential.keyHint).toHaveLength(4)
    expect(credential.secret).toBeUndefined()
    expect(credential.vaultState).toBeUndefined()
    expect(
      await server.db
        .collection('teamDeployments')
        .findOne({ teamId, environment: 'sandbox' })
    ).toMatchObject({
      gateway: expect.objectContaining({ credentialType: 'oauth' }),
      oauthClient: { enabled: true, appRoles: [] }
    })

    // The secret reached the vault: a team admin can reveal it, with a reason.
    const revealed = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${credential._id}/reveal`,
      headers: { 'x-user-id': adminId },
      payload: { reason: 'Handing it to the team secret store' }
    })

    expect(revealed.statusCode).toBe(200)
    expect(revealed.result.secret).toEqual(
      expect.stringContaining('mock-oauth-')
    )
    expect(revealed.result.secret.slice(-4)).toBe(credential.keyHint)
  })

  test('no response a team member can read carries the team secret', async () => {
    const adminId = 'team-cred-nosecret-1'
    const teamId = await createTeamWithActiveDeployment(adminId)
    const credential = await teamCredentialOf(teamId)
    const memberId = await inviteAndSignIn(
      teamId,
      adminId,
      'nosecret-member@defra.gov.uk',
      'No Secret Member'
    )
    const headers = { 'x-user-id': memberId }
    const responses = await Promise.all([
      server.inject({ method: 'GET', url: '/v1/credentials', headers }),
      server.inject({
        method: 'GET',
        url: `/v1/credentials/${credential._id}`,
        headers
      }),
      server.inject({
        method: 'GET',
        url: `/v1/teams/${teamId}/deployments`,
        headers
      })
    ])

    for (const response of responses) {
      expect(response.statusCode).toBe(200)
      expect(response.payload).not.toContain('mock-oauth-')
    }
  })

  test('the first activation creates the credential and concurrent or repeat activations are idempotent', async () => {
    const teamId = new ObjectId().toString()
    const { ensureTeamCredential } =
      await import('#/services/credential-service.js')
    const params = {
      teamId,
      environment: 'sandbox',
      modelSlug: 'gpt-4o',
      requestedBy: 'team-cred-idem-1',
      operationId: 'op-idem'
    }

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureTeamCredential(server.db, server.locker, params)
      )
    )
    const again = await ensureTeamCredential(server.db, server.locker, params)

    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(again.created).toBe(false)
    expect(again.credential._id.toString()).toBe(
      results[0].credential._id.toString()
    )
    expect(await activeTeamCredentials(teamId)).toHaveLength(1)
  })

  test('different environments get different credentials', async () => {
    const teamId = new ObjectId().toString()
    const { ensureTeamCredential } =
      await import('#/services/credential-service.js')
    const params = {
      teamId,
      modelSlug: 'gpt-4o',
      requestedBy: 'team-cred-envs-1',
      operationId: 'op-envs'
    }

    const sandbox = await ensureTeamCredential(server.db, server.locker, {
      ...params,
      environment: 'sandbox',
      operationId: 'op-envs-sandbox'
    })
    const preprod = await ensureTeamCredential(server.db, server.locker, {
      ...params,
      environment: 'preprod',
      operationId: 'op-envs-preprod'
    })

    expect(sandbox.created).toBe(true)
    expect(preprod.created).toBe(true)
    expect(sandbox.credential._id.toString()).not.toBe(
      preprod.credential._id.toString()
    )
    expect(preprod.credential).toMatchObject({
      environment: 'preprod',
      externalGatewaySubscriptionId: `team-${teamId}-preprod`
    })
  })

  test('POST /v1/credentials refuses a team credential request', async () => {
    const teamId = await createTeamWithActiveDeployment('team-cred-user-2')

    const { statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: {
        'x-user-id': 'team-cred-user-2',
        'idempotency-key': randomUUID()
      },
      payload: {
        modelSlug: 'gpt-4o',
        tier: 'team',
        teamId,
        environment: 'sandbox'
      }
    })

    expect(statusCode).toBe(400)
    expect(await activeTeamCredentials(teamId)).toHaveLength(1)
  })

  test('a second model for the same team and environment reuses the credential and is granted to it', async () => {
    const userId = 'team-cred-user-6'
    const teamId = await createTeamWithActiveDeployment(userId, 'gpt-4o')
    const first = await teamCredentialOf(teamId)

    const requesterId = await inviteAndSignIn(
      teamId,
      userId,
      'second-model-requester@defra.gov.uk',
      'Second Model Requester'
    )

    await requestActiveDeployment(teamId, requesterId, 'gpt-5-mini')

    const credentials = await activeTeamCredentials(teamId)
    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/credentials/${first._id}`,
      headers: { 'x-user-id': userId }
    })

    expect(credentials).toHaveLength(1)
    expect(credentials[0]._id.toString()).toBe(first._id.toString())
    expect(credentials[0].keyHint).toBe(first.keyHint)
    expect(result.allowedDeployments.sort()).toEqual(['gpt-4o', 'gpt-5-mini'])
  })

  describe('a team credential covers what the team is granted', () => {
    async function listedCredential(userId, id) {
      const { result } = await server.inject({
        method: 'GET',
        url: '/v1/credentials',
        headers: { 'x-user-id': userId }
      })

      return result.items.find((item) => item._id.toString() === id)
    }

    // A removal is attributed to the person, so a signed-in admin makes it.
    async function signedInAdmin(teamId, creatorId, label) {
      const userId = await inviteAndSignIn(
        teamId,
        creatorId,
        `${label}@defra.gov.uk`,
        label
      )

      await server.db
        .collection('teamMembers')
        .updateOne({ teamId, userId }, { $set: { role: 'admin' } })

      return userId
    }

    async function removeActiveModel(teamId, creatorId, modelSlug) {
      const adminId = await signedInAdmin(
        teamId,
        creatorId,
        `remover-${randomUUID().slice(-8)}`
      )
      const { result } = await server.inject({
        method: 'GET',
        url: `/v1/teams/${teamId}/deployments`,
        headers: { 'x-user-id': adminId }
      })
      const deployment = result.items.find(
        (item) => item.modelSlug === modelSlug
      )

      const response = await server.inject({
        method: 'DELETE',
        url: `/v1/teams/${teamId}/deployments/${deployment._id}`,
        headers: { 'x-user-id': adminId }
      })

      // The removal is accepted, then applies in the background.
      await settled()

      return response
    }

    test('lists a second model once its deployment is active, with no issue call', async () => {
      const userId = 'team-grants-user-1'
      const teamId = await createTeamWithActiveDeployment(userId)
      const credential = await teamCredentialOf(teamId)
      const requesterId = await inviteAndSignIn(
        teamId,
        userId,
        'grants-requester-1@defra.gov.uk',
        'Grants Requester'
      )

      await requestActiveDeployment(teamId, requesterId, 'gpt-5-mini')

      const listed = await listedCredential(userId, credential._id.toString())

      expect(listed.allowedDeployments.sort()).toEqual(['gpt-4o', 'gpt-5-mini'])
    })

    test('no longer lists a model the team removed', async () => {
      const userId = 'team-grants-user-2'
      const teamId = await createTeamWithActiveDeployment(userId)
      const credential = await teamCredentialOf(teamId)

      const removed = await removeActiveModel(teamId, userId, 'gpt-4o')

      expect(removed.statusCode).toBe(202)
      expect(
        (await listedCredential(userId, credential._id.toString()))
          .allowedDeployments
      ).toEqual([])
    })

    test('keeps what a revoked credential covered when it was revoked', async () => {
      const userId = 'team-grants-user-3'
      const teamId = await createTeamWithActiveDeployment(userId)
      const credential = await teamCredentialOf(teamId)
      const id = credential._id.toString()

      await server.inject({
        method: 'DELETE',
        url: `/v1/credentials/${id}`,
        headers: { 'x-user-id': userId }
      })
      const removed = await removeActiveModel(teamId, userId, 'gpt-4o')

      const revoked = await listedCredential(userId, id)

      expect(removed.statusCode).toBe(202)
      expect(revoked.status).toBe('revoked')
      expect(revoked.allowedDeployments).toEqual(['gpt-4o'])
    })

    test('stores no copy of the coverage while the credential is active', async () => {
      const teamId = await createTeamWithActiveDeployment('team-grants-user-4')
      const stored = await teamCredentialOf(teamId)

      expect(stored.allowedDeployments).toBeUndefined()
    })
  })

  test('a failed credential is retried on the next maintenance sweep once the issuer works again', async () => {
    const adminId = 'team-cred-retry-1'
    const teamId = await createTeamWithActiveDeployment(adminId)
    const credential = await teamCredentialOf(teamId)

    // What a failed attempt, made a while ago, leaves behind.
    await server.db.collection('credentials').updateOne(
      { _id: credential._id },
      {
        $set: {
          status: 'failed',
          failureReason: 'issuer-error',
          createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
        }
      }
    )

    const { recoverTeamCredentials } =
      await import('#/services/team-credential-grant.js')

    await recoverTeamCredentials(server.db, { locker: server.locker })

    const credentials = await server.db
      .collection('credentials')
      .find({ teamId, environment: 'sandbox', tier: 'team' })
      .toArray()

    expect(credentials).toHaveLength(1)
    expect(credentials[0]._id.toString()).toBe(credential._id.toString())
    expect(credentials[0].status).toBe('active')
    expect(credentials[0].failureReason).toBeUndefined()
  })

  test('no team credential exists while the deployment is still being set up', async () => {
    const team = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: {
        'x-user-id': 'team-cred-user-3',
        'idempotency-key': randomUUID()
      },
      payload: { name: 'Team team-cred-user-3', serviceCode: 'ABC' }
    })
    const teamId = team.result.team._id.toString()
    const requesterId = await inviteAndSignIn(
      teamId,
      'team-cred-user-3',
      'not-ready-requester@defra.gov.uk',
      'Not Ready Requester'
    )

    const requested = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/deployments`,
      headers: { 'x-user-id': requesterId, 'idempotency-key': randomUUID() },
      payload: { modelSlugs: ['gpt-4o'], environment: 'sandbox' }
    })

    expect(requested.statusCode).toBe(201)
    expect(await teamCredentialOf(teamId)).toBeNull()
  })

  test('GET /v1/credentials lists a shared team credential for another active team member', async () => {
    const teamId = await createTeamWithActiveDeployment('team-cred-user-5')

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/members`,
      headers: {
        'x-user-id': 'team-cred-user-5',
        'idempotency-key': randomUUID()
      },
      payload: { email: 'teammate@defra.gov.uk' }
    })

    const signIn = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: randomUUID(),
        tid: ENTRA_TENANT_ID,
        email: 'teammate@defra.gov.uk',
        displayName: 'Teammate'
      }
    })

    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/credentials',
      headers: { 'x-user-id': signIn.result.user._id.toString() }
    })

    expect(statusCode).toBe(200)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].teamId).toBe(teamId)
    expect(result.items[0].secret).toBeUndefined()
  })

  async function inviteAndSignIn(teamId, adminUserId, email, displayName) {
    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/members`,
      headers: { 'x-user-id': adminUserId, 'idempotency-key': randomUUID() },
      payload: { email }
    })

    const signIn = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: { oid: randomUUID(), tid: ENTRA_TENANT_ID, email, displayName }
    })

    return signIn.result.user._id.toString()
  }

  test('POST /v1/credentials/{id}/rotate lets a team admin rotate the shared credential', async () => {
    const adminId = 'team-cred-rotate-1'
    const teamId = await createTeamWithActiveDeployment(adminId)
    const credential = await teamCredentialOf(teamId)

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${credential._id}/rotate`,
      headers: { 'x-user-id': adminId }
    })

    expect(statusCode).toBe(200)
    expect(result.secret).toEqual(expect.stringContaining('mock-oauth-'))
    expect(result.credential.keyHint).toBe(result.secret.slice(-4))
    expect(result.credential.keyHint).not.toBe(credential.keyHint)
  })

  test('POST /v1/credentials/{id}/rotate refuses a user-role team member', async () => {
    const adminId = 'team-cred-rotate-2'
    const teamId = await createTeamWithActiveDeployment(adminId)
    const credential = await teamCredentialOf(teamId)

    const memberId = await inviteAndSignIn(
      teamId,
      adminId,
      'rotate-member@defra.gov.uk',
      'Rotate Member'
    )

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${credential._id}/rotate`,
      headers: { 'x-user-id': memberId }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('admin-required')
  })

  test('POST /v1/credentials/{id}/rotate returns 404 for a non-member', async () => {
    const adminId = 'team-cred-rotate-3'
    const teamId = await createTeamWithActiveDeployment(adminId)
    const credential = await teamCredentialOf(teamId)

    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${credential._id}/rotate`,
      headers: { 'x-user-id': 'someone-else-entirely' }
    })

    expect(statusCode).toBe(404)
  })

  test('DELETE /v1/credentials/{id} lets the team admin revoke the shared credential', async () => {
    const adminId = 'team-cred-revoke-1'
    const teamId = await createTeamWithActiveDeployment(adminId)
    const credential = await teamCredentialOf(teamId)

    const { statusCode } = await server.inject({
      method: 'DELETE',
      url: `/v1/credentials/${credential._id}`,
      headers: { 'x-user-id': adminId }
    })

    expect(statusCode).toBe(204)
  })

  test('DELETE /v1/credentials/{id} returns 404 when a different team\u2019s admin requests it', async () => {
    const adminId = 'team-cred-revoke-3'
    const teamId = await createTeamWithActiveDeployment(adminId)
    const credential = await teamCredentialOf(teamId)

    const otherTeam = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: {
        'x-user-id': 'team-cred-revoke-3-other',
        'idempotency-key': randomUUID()
      },
      payload: { name: 'A Different Team', serviceCode: 'ABC' }
    })

    const { statusCode } = await server.inject({
      method: 'DELETE',
      url: `/v1/credentials/${credential._id}`,
      headers: { 'x-user-id': 'team-cred-revoke-3-other' }
    })

    expect(otherTeam.statusCode).toBe(201)
    expect(statusCode).toBe(404)
  })

  test('DELETE /v1/credentials/{id} refuses a user-role team member', async () => {
    const adminId = 'team-cred-revoke-2'
    const teamId = await createTeamWithActiveDeployment(adminId)
    const credential = await teamCredentialOf(teamId)

    const memberId = await inviteAndSignIn(
      teamId,
      adminId,
      'revoke-member@defra.gov.uk',
      'Revoke Member'
    )

    const { result, statusCode } = await server.inject({
      method: 'DELETE',
      url: `/v1/credentials/${credential._id}`,
      headers: { 'x-user-id': memberId }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('admin-required')
  })

  test('POST /v1/credentials/{id}/reveal returns the secret with a reason', async () => {
    const headers = {
      'x-user-id': 'user-reveal-1',
      'idempotency-key': randomUUID()
    }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })

    const {
      result,
      statusCode,
      headers: responseHeaders
    } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${issued.result.credential._id}/reveal`,
      headers: { 'x-user-id': 'user-reveal-1' },
      payload: { reason: 'Re-sharing with a teammate' }
    })

    expect(statusCode).toBe(200)
    expect(result.secret).toBe(issued.result.secret)
    expect(responseHeaders['cache-control']).toBe('no-store')
    expect(responseHeaders.pragma).toBe('no-cache')
  })

  test('POST /v1/credentials/{id}/reveal requires a reason', async () => {
    const headers = {
      'x-user-id': 'user-reveal-2',
      'idempotency-key': randomUUID()
    }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })

    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${issued.result.credential._id}/reveal`,
      headers: { 'x-user-id': 'user-reveal-2' },
      payload: {}
    })

    expect(statusCode).toBe(400)
  })

  test('POST /v1/credentials/{id}/reveal returns 404 for another user\u2019s credential', async () => {
    const headers = {
      'x-user-id': 'user-reveal-3',
      'idempotency-key': randomUUID()
    }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })

    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${issued.result.credential._id}/reveal`,
      headers: { 'x-user-id': 'someone-else-entirely' },
      payload: { reason: 'Trying to view someone else\u2019s key' }
    })

    expect(statusCode).toBe(404)
  })

  test('POST /v1/credentials/{id}/reveal returns 409 credential-revoked for a revoked credential', async () => {
    const headers = {
      'x-user-id': 'user-reveal-4',
      'idempotency-key': randomUUID()
    }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })

    await server.inject({
      method: 'DELETE',
      url: `/v1/credentials/${issued.result.credential._id}`,
      headers: { 'x-user-id': 'user-reveal-4' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${issued.result.credential._id}/reveal`,
      headers: { 'x-user-id': 'user-reveal-4' },
      payload: { reason: 'Checking after revoke' }
    })

    expect(statusCode).toBe(409)
    expect(result.code).toBe('credential-revoked')
  })

  test('POST /v1/credentials/{id}/reveal refuses a user-role team member', async () => {
    const adminId = 'team-cred-reveal-1'
    const teamId = await createTeamWithActiveDeployment(adminId)
    const credential = await teamCredentialOf(teamId)

    const memberId = await inviteAndSignIn(
      teamId,
      adminId,
      'reveal-member@defra.gov.uk',
      'Reveal Member'
    )

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${credential._id}/reveal`,
      headers: { 'x-user-id': memberId },
      payload: { reason: 'Trying to view the shared key' }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('admin-required')
    expect(result.secret).toBeUndefined()
  })

  test('POST /v1/credentials/{id}/reveal returns 404 for a non-member of the team', async () => {
    const adminId = 'team-cred-reveal-3'
    const teamId = await createTeamWithActiveDeployment(adminId)
    const credential = await teamCredentialOf(teamId)

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${credential._id}/reveal`,
      headers: { 'x-user-id': 'someone-else-entirely' },
      payload: { reason: 'Trying to view another team’s key' }
    })

    expect(statusCode).toBe(404)
    expect(result.secret).toBeUndefined()
  })

  test('POST /v1/credentials/{id}/reveal lets a team admin view the shared secret', async () => {
    const adminId = 'team-cred-reveal-2'
    const teamId = await createTeamWithActiveDeployment(adminId)
    const credential = await teamCredentialOf(teamId)

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/credentials/${credential._id}/reveal`,
      headers: { 'x-user-id': adminId },
      payload: { reason: 'Re-sharing with a new teammate' }
    })

    expect(statusCode).toBe(200)
    expect(result.secret).toEqual(expect.stringContaining('mock-oauth-'))
    expect(result.secret.slice(-4)).toBe(credential.keyHint)
  })
})
