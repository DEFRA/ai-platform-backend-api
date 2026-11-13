import { randomUUID } from 'node:crypto'

import {
  appAuth,
  authFor,
  withTestUsers
} from '#/common/test-helpers/portal-token.js'

const ENVIRONMENTS = ['route-dev', 'route-test']
const DEV = ENVIRONMENTS[0]
const TEST = ENVIRONMENTS[1]
const ADMIN = 'deployments-route-admin'
const REASON = 'A client secret was shared in a ticket'
const BASE = '/v1/admin/team-deployments'

describe('#admin team-deployments Deployments tab routes', () => {
  let server
  let config
  let configured

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    ;({ config } = await import('#/config.js'))
    configured = config.get('teamDeployment.environments')
    config.set('teamDeployment.environments', ENVIRONMENTS)

    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    withTestUsers(server)
  })

  afterAll(async () => {
    config.set('teamDeployment.environments', configured)
    await server.stop({ timeout: 0 })
  })

  beforeEach(async () => {
    await Promise.all(
      ['teamDeployments', 'teams', 'teamMembers', 'credentials'].map((name) =>
        server.db.collection(name).deleteMany({})
      )
    )
    await server.db.collection('auditEvents').deleteMany({})
  })

  const asAdmin = () =>
    authFor(ADMIN, { roles: ['research-user', 'platform-admin'] })
  const asPerson = () => authFor('deployments-route-person')

  function call(method, url, { headers = asAdmin(), payload } = {}) {
    return server.inject({ method, url, headers, payload })
  }

  const withKey = (headers = asAdmin(), key = randomUUID()) => ({
    ...headers,
    'idempotency-key': key
  })

  async function seedTeam() {
    const name = `Route Team ${randomUUID().slice(0, 8)}`
    const { insertedId } = await server.db.collection('teams').insertOne({
      name,
      normalisedName: name.toLowerCase().replaceAll(' ', '-'),
      slug: name.toLowerCase().replaceAll(' ', '-')
    })
    const teamId = insertedId.toString()

    await server.db.collection('teamDeployments').insertMany(
      ENVIRONMENTS.map((environment) => ({
        teamId,
        environment,
        deployments: [
          {
            id: randomUUID(),
            modelSlug: 'gpt-4o',
            status: 'active',
            statusTimes: { active: '2026-10-30T11:00:00.000Z' }
          }
        ]
      }))
    )

    return { teamId, name }
  }

  async function seedCredential(teamId, environment) {
    const { insertedId } = await server.db.collection('credentials').insertOne({
      userId: 'requester',
      teamId,
      environment,
      tier: 'team',
      credentialType: 'oauth',
      status: 'active',
      issuerKey: 'mock',
      keyHint: 'WXYZ',
      externalGatewaySubscriptionId: `ext-${randomUUID()}`
    })

    return insertedId
  }

  const denied = () =>
    server.db
      .collection('auditEvents')
      .find({ action: 'access.denied' })
      .toArray()

  describe(`GET ${BASE}`, () => {
    test('lists the deployments in the first environment by default, with the lists the filters need', async () => {
      const { teamId, name } = await seedTeam()

      await seedCredential(teamId, DEV)

      const { statusCode, result } = await call('GET', BASE)

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        page: 1,
        pageSize: 25,
        total: 1,
        environment: DEV,
        options: { environments: ENVIRONMENTS }
      })
      expect(result.deployments).toEqual([
        {
          teamId,
          teamName: name,
          environment: DEV,
          models: [expect.objectContaining({ slug: 'gpt-4o' })],
          status: 'ready',
          credential: 'active',
          lastChangedAt: '2026-10-30T11:00:00.000Z'
        }
      ])
    })

    test('takes an environment, a search, a model, a status, a credential and a page', async () => {
      const { teamId } = await seedTeam()
      const query = new URLSearchParams({
        environment: TEST,
        search: 'route team',
        model: 'gpt-4o',
        status: 'ready',
        credential: 'none',
        page: '1'
      })

      const { statusCode, result } = await call('GET', `${BASE}?${query}`)

      expect(statusCode).toBe(200)
      expect(result.environment).toBe(TEST)
      expect(result.deployments.map((row) => row.teamId)).toEqual([teamId])
    })

    test.each([
      ['an environment the instance does not list', 'environment=nowhere'],
      ['a search that is too short', 'search=a'],
      ['a search that is too long', `search=${'a'.repeat(101)}`],
      ['a status that is not one', 'status=broken'],
      ['a credential that is not one', 'credential=broken'],
      ['a page that is not a number', 'page=abc'],
      ['a page below 1', 'page=0'],
      ['a key the route does not take', 'colour=red']
    ])('refuses %s with 400 invalid-query', async (_name, query) => {
      const { statusCode, result } = await call('GET', `${BASE}?${query}`)

      expect(statusCode).toBe(400)
      expect(result.code).toBe('invalid-query')
      expect(JSON.stringify(result)).not.toContain('colour')
    })

    test('refuses a person who is not a Platform Admin with 403 and an access.denied event', async () => {
      const { statusCode, result } = await call('GET', BASE, {
        headers: asPerson()
      })

      expect(statusCode).toBe(403)
      expect(result.code).toBe('platform-admin-required')
      expect(await denied()).toHaveLength(1)
    })

    test('refuses the frontend’s app-only token with 401 invalid-token and no event', async () => {
      const { statusCode, result } = await call('GET', BASE, {
        headers: appAuth()
      })

      expect(statusCode).toBe(401)
      expect(result.code).toBe('invalid-token')
      expect(await denied()).toEqual([])
    })

    test('refuses a request with no token with 401', async () => {
      const { statusCode } = await call('GET', BASE, { headers: {} })

      expect(statusCode).toBe(401)
    })
  })

  describe(`GET ${BASE}/{teamId}/{environment}`, () => {
    test('returns the team, status, credential, models and the team’s environments, with no secret', async () => {
      const { teamId, name } = await seedTeam()

      await seedCredential(teamId, DEV)

      const { statusCode, result } = await call(
        'GET',
        `${BASE}/${teamId}/${DEV}`
      )

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        team: { id: teamId, name, status: 'active', memberCount: 0 },
        environment: DEV,
        status: 'ready',
        credential: { status: 'active' },
        deployments: [
          expect.objectContaining({
            modelSlug: 'gpt-4o',
            status: 'active',
            retryable: false
          })
        ],
        environments: [
          { environment: DEV, credential: { status: 'active' } },
          { environment: TEST, credential: { status: 'none' } }
        ]
      })
      expect(JSON.stringify(result)).not.toContain('WXYZ')
      expect(JSON.stringify(result)).not.toContain('ext-')
    })

    test.each([
      ['a team that does not exist', `${BASE}/000000000000000000000000/${DEV}`],
      ['an id that is not a team', `${BASE}/not-a-team/${DEV}`]
    ])('answers 404 deployment-not-found for %s', async (_name, url) => {
      const { statusCode, result } = await call('GET', url)

      expect(statusCode).toBe(404)
      expect(result.code).toBe('deployment-not-found')
    })

    test('answers 404 for an environment the instance does not list', async () => {
      const { teamId } = await seedTeam()

      expect(
        (await call('GET', `${BASE}/${teamId}/elsewhere`)).statusCode
      ).toBe(404)
    })

    test('refuses a person who is not a Platform Admin with 403', async () => {
      const { teamId } = await seedTeam()
      const { statusCode } = await call('GET', `${BASE}/${teamId}/${DEV}`, {
        headers: asPerson()
      })

      expect(statusCode).toBe(403)
      expect(await denied()).toHaveLength(1)
    })

    test('refuses the app-only token with 401', async () => {
      const { teamId } = await seedTeam()
      const { statusCode, result } = await call(
        'GET',
        `${BASE}/${teamId}/${DEV}`,
        {
          headers: appAuth()
        }
      )

      expect(statusCode).toBe(401)
      expect(result.code).toBe('invalid-token')
    })
  })

  describe.each([['disable'], ['revoke']])(
    'POST …/credentials/%s',
    (action) => {
      const url = (teamId, environment = DEV) =>
        `${BASE}/${teamId}/${environment}/credentials/${action}`

      function post(
        teamId,
        { reason = REASON, headers = withKey(), ...rest } = {}
      ) {
        return call('POST', url(teamId, rest.environment), {
          headers,
          payload: { reason }
        })
      }

      const events = (teamId) =>
        server.db
          .collection('auditEvents')
          .find({ action: `admin.credentials.${action}`, teamId })
          .toArray()

      test('acts on one environment and writes one event with the reason', async () => {
        const { teamId } = await seedTeam()

        await seedCredential(teamId, DEV)

        const { statusCode, result } = await post(teamId)

        expect(statusCode).toBe(200)
        expect(result.environment).toBe(DEV)
        expect(
          action === 'disable' ? result.credential.status : result.revoked
        ).toEqual(action === 'disable' ? 'disabled' : 1)
        expect(await events(teamId)).toEqual([
          expect.objectContaining({
            reason: REASON,
            environment: DEV,
            role: 'platform-admin'
          })
        ])
      })

      test('a repeat with the same Idempotency-Key and reason is a 200 with no second event', async () => {
        const { teamId } = await seedTeam()
        const headers = withKey()

        await seedCredential(teamId, DEV)
        await post(teamId, { headers })

        const again = await post(teamId, { headers })

        expect(again.statusCode).toBe(200)
        expect(await events(teamId)).toHaveLength(1)
      })

      test('the same Idempotency-Key with another reason is 409 idempotency-key-reused', async () => {
        const { teamId } = await seedTeam()
        const headers = withKey()

        await seedCredential(teamId, DEV)
        await post(teamId, { headers })

        const { statusCode, result } = await post(teamId, {
          headers,
          reason: 'Another reason'
        })

        expect(statusCode).toBe(409)
        expect(result.code).toBe('idempotency-key-reused')
      })

      test.each([
        [1, 200],
        [500, 200],
        [501, 400]
      ])('takes a reason of %i characters: %i', async (length, expected) => {
        const { teamId } = await seedTeam()
        const { statusCode, result } = await post(teamId, {
          reason: 'x'.repeat(length)
        })

        expect(statusCode).toBe(expected)

        if (expected === 400) {
          expect(result.code).toBe('reason-too-long')
          expect(await events(teamId)).toEqual([])
        }
      })

      test('trims a reason, and refuses one of only spaces as reason-required', async () => {
        const { teamId } = await seedTeam()

        await seedCredential(teamId, DEV)

        expect(
          (await post(teamId, { reason: `  ${REASON}  ` })).statusCode
        ).toBe(200)
        expect((await events(teamId))[0].reason).toBe(REASON)

        const blank = await post(teamId, { reason: '   ' })

        expect(blank.statusCode).toBe(400)
        expect(blank.result.code).toBe('reason-required')
      })

      test.each([
        ['an empty reason', { reason: '' }],
        ['no reason', {}],
        ['a reason that is not text', { reason: 12 }]
      ])(
        'refuses %s as reason-required and changes nothing',
        async (_name, payload) => {
          const { teamId } = await seedTeam()
          const { statusCode, result } = await call('POST', url(teamId), {
            headers: withKey(),
            payload
          })

          expect(statusCode).toBe(400)
          expect(result.code).toBe('reason-required')
          expect(await events(teamId)).toEqual([])
        }
      )

      test('refuses a key the route does not take as invalid-request, never echoing it', async () => {
        const { teamId } = await seedTeam()
        const { statusCode, result } = await call('POST', url(teamId), {
          headers: withKey(),
          payload: { reason: REASON, extra: 'surprise' }
        })

        expect(statusCode).toBe(400)
        expect(result.code).toBe('invalid-request')
        expect(JSON.stringify(result)).not.toContain('surprise')
      })

      test.each([
        ['no Idempotency-Key', () => asAdmin()],
        [
          'an Idempotency-Key that is not a version 4 UUID',
          () => withKey(asAdmin(), 'abc')
        ]
      ])('refuses %s as invalid-request', async (_name, headersOf) => {
        const { teamId } = await seedTeam()
        const { statusCode, result } = await call('POST', url(teamId), {
          headers: headersOf(),
          payload: { reason: REASON }
        })

        expect(statusCode).toBe(400)
        expect(result.code).toBe('invalid-request')
      })

      test('answers 404 deployment-not-found for an unknown team or environment', async () => {
        const { teamId } = await seedTeam()
        const unknownTeam = await post('000000000000000000000000')
        const unknownEnvironment = await post(teamId, {
          environment: 'elsewhere'
        })

        for (const { statusCode, result } of [
          unknownTeam,
          unknownEnvironment
        ]) {
          expect(statusCode).toBe(404)
          expect(result.code).toBe('deployment-not-found')
        }
      })

      test('refuses a person who is not a Platform Admin with 403, an access.denied event and no change', async () => {
        const { teamId } = await seedTeam()
        const record = await seedCredential(teamId, DEV)
        const { statusCode, result } = await post(teamId, {
          headers: withKey(asPerson())
        })

        expect(statusCode).toBe(403)
        expect(result.code).toBe('platform-admin-required')
        expect(await events(teamId)).toEqual([])
        expect(await denied()).toHaveLength(1)
        expect(
          (await server.db.collection('credentials').findOne({ _id: record }))
            .status
        ).toBe('active')
      })

      test('refuses the app-only token with 401 and no event', async () => {
        const { teamId } = await seedTeam()
        const { statusCode, result } = await post(teamId, {
          headers: withKey(appAuth())
        })

        expect(statusCode).toBe(401)
        expect(result.code).toBe('invalid-token')
        expect(await denied()).toEqual([])
      })
    }
  )

  describe('POST …/credentials/enable', () => {
    const url = (teamId, environment = DEV) =>
      `${BASE}/${teamId}/${environment}/credentials/enable`

    test('enables a disabled environment with no body and no Idempotency-Key', async () => {
      const { teamId } = await seedTeam()

      await call('POST', `${BASE}/${teamId}/${DEV}/credentials/disable`, {
        headers: withKey(),
        payload: { reason: REASON }
      })

      const { statusCode, result } = await call('POST', url(teamId))

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        environment: DEV,
        credential: { status: 'none' }
      })
      expect(
        await server.db
          .collection('auditEvents')
          .countDocuments({ action: 'admin.credentials.enable', teamId })
      ).toBe(1)
    })

    test('takes an empty object, and an environment that is not disabled is a 200 with no event', async () => {
      const { teamId } = await seedTeam()
      const { statusCode } = await call('POST', url(teamId), { payload: {} })

      expect(statusCode).toBe(200)
      expect(
        await server.db
          .collection('auditEvents')
          .countDocuments({ action: 'admin.credentials.enable' })
      ).toBe(0)
    })

    test('refuses a body with a key the route does not take', async () => {
      const { teamId } = await seedTeam()
      const { statusCode } = await call('POST', url(teamId), {
        payload: { reason: REASON }
      })

      expect(statusCode).toBe(400)
    })

    test('answers 404 for an unknown team and 403 for a person who is not a Platform Admin', async () => {
      const { teamId } = await seedTeam()

      expect(
        (await call('POST', url('000000000000000000000000'))).statusCode
      ).toBe(404)
      expect(
        (await call('POST', url(teamId), { headers: asPerson() })).statusCode
      ).toBe(403)
      expect(
        (await call('POST', url(teamId), { headers: appAuth() })).statusCode
      ).toBe(401)
    })
  })

  test('the built retry and reconcile routes are still registered', () => {
    const names = server.table().map((route) => `${route.method} ${route.path}`)

    expect(names).toContain(`post ${BASE}/{id}/retry`)
    expect(names).toContain(`post ${BASE}/{id}/reconcile`)
  })
})
