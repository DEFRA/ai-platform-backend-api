import nock from 'nock'

import { ACCESS } from '#/common/helpers/auth/access.js'
import {
  AUDIENCE,
  ENTRA_HOST,
  FRONTEND_CLIENT_ID,
  ISSUER,
  JWKS_PATH,
  TENANT_ID,
  appClaims,
  delegatedClaims,
  mintToken,
  oidFor,
  publicJwks,
  serveJwks,
  unknownSigningKey,
  userIdFor
} from '#/common/test-helpers/portal-token.js'

const now = () => Math.floor(Date.now() / 1000)
const bearer = (token) => ({ authorization: `Bearer ${token}` })

describe('#tokenSource', () => {
  let tokenSource

  beforeAll(async () => {
    ;({ tokenSource } = await import('#/plugins/auth.js'))
  })

  test("uses the Defra tenant's v2 issuer and signing keys", () => {
    expect(tokenSource({ tenantId: TENANT_ID })).toEqual({
      issuer: ISSUER,
      jwksUri: `${ENTRA_HOST}${JWKS_PATH}`
    })
  })

  test("uses the mock provider's address, without a trailing slash, when one is set", () => {
    expect(
      tokenSource({
        tenantId: TENANT_ID,
        mockIssuerUrl: 'http://localhost:3010/'
      })
    ).toEqual({
      issuer: 'http://localhost:3010',
      jwksUri: 'http://localhost:3010/jwks'
    })
  })
})

describe('#auth', () => {
  let server

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')

    server = await createServer()
    server.route(
      [
        ['user', ACCESS.user],
        ['catalogue', ACCESS.catalogue],
        ['sign-in', ACCESS.signIn],
        ['team-member', ACCESS.teamMember]
      ].map(([name, access]) => ({
        method: 'GET',
        path: `/probe/${name}`,
        options: { app: { access } },
        handler: (request) => request.auth.credentials
      }))
    )
    server.route({
      method: 'GET',
      path: '/probe/undeclared',
      handler: () => 'reached'
    })
    await server.initialize()

    await server.db.collection('users').insertMany([
      {
        _id: userIdFor('known-person'),
        oid: oidFor('known-person'),
        tid: TENANT_ID,
        email: 'known.person@defra.gov.uk',
        displayName: 'Known Person',
        roles: ['research-user']
      },
      {
        _id: userIdFor('platform-admin'),
        oid: oidFor('platform-admin'),
        tid: TENANT_ID,
        email: 'admin@defra.gov.uk',
        displayName: 'Admin',
        roles: ['research-user', 'platform-admin']
      }
    ])
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  const known = (overrides) =>
    delegatedClaims({ oid: oidFor('known-person'), ...overrides })

  function get(url, headers) {
    return server.inject({ method: 'GET', url, headers })
  }

  describe('a valid delegated token', () => {
    test('reaches a route that needs a person, as that person', async () => {
      const { statusCode, result } = await get(
        '/probe/user',
        bearer(mintToken(known({ uti: 'token-7' })))
      )

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        kind: 'user',
        userId: userIdFor('known-person'),
        oid: oidFor('known-person'),
        tid: TENANT_ID,
        azp: FRONTEND_CLIENT_ID,
        uti: 'token-7',
        email: 'default.person@defra.gov.uk',
        name: 'Default Person',
        isPlatformAdmin: false
      })
    })

    test('carries the Platform Admin role held in the database', async () => {
      const { result } = await get(
        '/probe/user',
        bearer(mintToken(delegatedClaims({ oid: oidFor('platform-admin') })))
      )

      expect(result.isPlatformAdmin).toBe(true)
    })

    test('reaches the catalogue too', async () => {
      const { statusCode } = await get(
        '/probe/catalogue',
        bearer(mintToken(known()))
      )

      expect(statusCode).toBe(200)
    })

    test('may arrive at sign-in before the person has a record', async () => {
      const { statusCode, result } = await get(
        '/probe/sign-in',
        bearer(mintToken(delegatedClaims({ oid: oidFor('new-person') })))
      )

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        userId: null,
        oid: oidFor('new-person'),
        isPlatformAdmin: false
      })
    })

    test('ignores an x-user-id header', async () => {
      const { result } = await get('/probe/user', {
        ...bearer(mintToken(known())),
        'x-user-id': userIdFor('platform-admin')
      })

      expect(result.userId).toBe(userIdFor('known-person'))
    })

    test('accepts the scheme in any case and several scopes', async () => {
      const { statusCode } = await get('/probe/user', {
        authorization: `bearer ${mintToken(known({ scp: 'Other.Read Portal.Access' }))}`
      })

      expect(statusCode).toBe(200)
    })
  })

  describe('the edges of what is accepted', () => {
    test.each([
      [
        'a lifetime of exactly 2 hours',
        { exp: now() + 3600, iat: now() - 3600 }
      ],
      [
        'an expiry within the clock skew',
        { exp: now() - 30, iat: now() - 3000 }
      ],
      ['a start time within the clock skew', { nbf: now() + 30 }],
      ['an issue time within the clock skew', { iat: now() + 30 }],
      ['azpacr 1, a client secret', { azpacr: '1' }],
      ['an acct sent as the string 0', { acct: '0' }]
    ])('accepts %s', async (_name, overrides) => {
      const { statusCode } = await get(
        '/probe/user',
        bearer(mintToken(known(overrides)))
      )

      expect(statusCode).toBe(200)
    })
  })

  describe('a request that is refused', () => {
    function expectInvalidToken({ statusCode, result, headers }) {
      expect(statusCode).toBe(401)
      expect(result.code).toBe('invalid-token')
      expect(headers['www-authenticate']).toContain('Bearer')
    }

    test('with no token says only that one is needed', async () => {
      const response = await get('/probe/user')

      expectInvalidToken(response)
      expect(response.headers['www-authenticate']).toBe(
        'Bearer realm="aip-portal"'
      )
    })

    test('with x-user-id and no token is still refused', async () => {
      const response = await get('/probe/user', {
        'x-user-id': userIdFor('known-person')
      })

      expectInvalidToken(response)
    })

    test.each([
      ['a token for the wrong scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
      ['a header with two tokens', { authorization: 'Bearer abc def' }],
      ['a token that is not a JWT', { authorization: 'Bearer not-a-jwt' }],
      ['an empty bearer token', { authorization: 'Bearer ' }]
    ])('with %s', async (_name, headers) => {
      expectInvalidToken(await get('/probe/user', headers))
    })

    const badTokens = [
      [
        'a signature from a key the tenant does not publish',
        () => mintToken(known(), { key: unknownSigningKey })
      ],
      [
        'a key ID the tenant does not publish',
        () => mintToken(known(), { kid: 'unknown-key' })
      ],
      ['algorithm none', () => mintToken(known(), { alg: 'none' })],
      [
        'algorithm HS256 keyed with the public key',
        () => mintToken(known(), { alg: 'HS256' })
      ],
      [
        'the wrong issuer',
        () => mintToken(known({ iss: 'https://evil.example/v2.0' }))
      ],
      [
        'the wrong tenant',
        () => mintToken(known({ tid: oidFor('other-tenant') }))
      ],
      [
        'the wrong audience, an ID token for the frontend',
        () => mintToken(known({ aud: FRONTEND_CLIENT_ID }))
      ],
      ['a v1 token', () => mintToken(known({ ver: '1.0' }))],
      ['the wrong authorised party', () => mintToken(known({ azp: AUDIENCE }))],
      ['no authorised party', () => mintToken(known({ azp: undefined }))],
      ['a public client, azpacr 0', () => mintToken(known({ azpacr: '0' }))],
      ['no azpacr', () => mintToken(known({ azpacr: undefined }))],
      [
        'an expiry beyond the clock skew',
        () => mintToken(known({ exp: now() - 120, iat: now() - 3000 }))
      ],
      [
        'a start time beyond the clock skew',
        () => mintToken(known({ nbf: now() + 120 }))
      ],
      [
        'an issue time beyond the clock skew',
        () => mintToken(known({ iat: now() + 120 }))
      ],
      ['no expiry', () => mintToken(known({ exp: undefined }))],
      [
        'a lifetime of 2 hours and a second',
        () => mintToken(known({ iat: now() - 3600, exp: now() + 3601 }))
      ],
      ['a guest, acct 1', () => mintToken(known({ acct: 1 }))],
      ['no acct', () => mintToken(known({ acct: undefined }))],
      ['no idtyp', () => mintToken(known({ idtyp: undefined }))],
      ['idtyp user with no scope', () => mintToken(known({ scp: undefined }))],
      [
        'idtyp user with another scope',
        () => mintToken(known({ scp: 'Other.Scope' }))
      ],
      ['idtyp app with a scope', () => mintToken(known({ idtyp: 'app' }))],
      ['an oid that is not a GUID', () => mintToken(known({ oid: 'someone' }))],
      [
        'an oid in capitals',
        () => mintToken(known({ oid: oidFor('known-person').toUpperCase() }))
      ],
      [
        'a person with no record',
        () => mintToken(delegatedClaims({ oid: oidFor('never-signed-in') }))
      ]
    ]

    test.each(badTokens)('with %s', async (_name, token) => {
      const response = await get('/probe/user', bearer(token()))

      expectInvalidToken(response)
      expect(response.headers['www-authenticate']).toContain(
        'error="invalid_token"'
      )
    })

    test('on a route that declares no access, whatever the token', async () => {
      expectInvalidToken(
        await get('/probe/undeclared', bearer(mintToken(known())))
      )
    })
  })

  describe("the frontend's own app-only token", () => {
    test('reads the catalogue as the application alone', async () => {
      const { statusCode, result } = await get(
        '/probe/catalogue',
        bearer(mintToken(appClaims({ uti: 'app-token-1' })))
      )

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        kind: 'app',
        tid: TENANT_ID,
        azp: FRONTEND_CLIENT_ID,
        uti: 'app-token-1',
        userId: null,
        isPlatformAdmin: false
      })
    })

    test.each(['user', 'sign-in', 'team-member', 'undeclared'])(
      'is refused on /probe/%s',
      async (name) => {
        const response = await get(
          `/probe/${name}`,
          bearer(mintToken(appClaims()))
        )

        expect(response.statusCode).toBe(401)
        expect(response.result.code).toBe('invalid-token')
      }
    )

    test.each([
      ['with a scope', { scp: 'Portal.Access' }],
      ['with no idtyp', { idtyp: undefined }],
      ['for another client', { azp: AUDIENCE }],
      ['from a public client', { azpacr: '0' }],
      ['for the wrong audience', { aud: FRONTEND_CLIENT_ID }]
    ])('is refused on the catalogue %s', async (_name, overrides) => {
      const { statusCode } = await get(
        '/probe/catalogue',
        bearer(mintToken(appClaims(overrides)))
      )

      expect(statusCode).toBe(401)
    })
  })

  describe('the public routes', () => {
    test('/health takes no token', async () => {
      const { statusCode } = await get('/health')

      expect(statusCode).toBe(200)
    })

    test('a bad token on /health changes nothing', async () => {
      const { statusCode } = await get('/health', { authorization: 'Bearer x' })

      expect(statusCode).toBe(200)
    })
  })
})

describe('#auth start-up', () => {
  afterEach(() => {
    nock.cleanAll()
    serveJwks()
  })

  test.each([
    ['an error from the key endpoint', (scope) => scope.reply(500, 'down')],
    ['no key it can use', (scope) => scope.reply(200, { keys: [] })],
    ['a connection that fails', (scope) => scope.replyWithError('refused')]
  ])('refuses to start with %s', async (_name, reply) => {
    nock.cleanAll()
    reply(nock(ENTRA_HOST).get(JWKS_PATH))

    const { createServer } = await import('#/server.js')
    const server = await createServer()

    await expect(server.initialize()).rejects.toThrow()
    await server.stop({ timeout: 0 }).catch(() => {})
  })

  test('fetches the keys before it serves a request', async () => {
    nock.cleanAll()
    const keys = nock(ENTRA_HOST).get(JWKS_PATH).reply(200, publicJwks())

    const { createServer } = await import('#/server.js')
    const server = await createServer()

    expect(keys.isDone()).toBe(false)

    await server.initialize()

    expect(keys.isDone()).toBe(true)
    await server.stop({ timeout: 0 })
  })
})
