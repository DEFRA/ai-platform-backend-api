import { randomUUID } from 'node:crypto'

import {
  FRONTEND_CLIENT_ID,
  TENANT_ID,
  appClaims,
  delegatedClaims,
  mintToken
} from '#/common/test-helpers/portal-token.js'

const bearer = (claims) => ({
  authorization: `Bearer ${mintToken(claims)}`
})

describe('#users routes', () => {
  let server

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  // Signs in as the person the token's claims describe, sending no body.
  function signIn({ oid = randomUUID(), ...claims } = {}) {
    return server.inject({
      method: 'PUT',
      url: '/v1/users/me',
      headers: bearer(
        delegatedClaims({
          oid,
          name: 'Test User',
          email: 'test.user@defra.gov.uk',
          ...claims
        })
      )
    })
  }

  function usersWithEmail(email) {
    return server.db.collection('users').find({ email }).toArray()
  }

  test('PUT /v1/users/me upserts a user keyed on their Entra object and tenant IDs', async () => {
    const oid = randomUUID()
    const { result, statusCode } = await signIn({
      oid,
      email: 'test.user@defra.gov.uk'
    })

    expect(statusCode).toBe(200)
    expect(result.user).toMatchObject({
      oid,
      tid: TENANT_ID,
      email: 'test.user@defra.gov.uk',
      displayName: 'Test User',
      roles: ['research-user']
    })
    expect(result.team).toBeNull()
  })

  test('PUT /v1/users/me keeps one record per identity and refreshes its display fields', async () => {
    const oid = randomUUID()
    const first = await signIn({ oid, email: 'renamed.before@defra.gov.uk' })
    const second = await signIn({
      oid,
      email: 'Renamed.After@defra.gov.uk',
      name: 'Renamed User'
    })

    expect(second.result.user._id.toString()).toBe(
      first.result.user._id.toString()
    )
    expect(second.result.user).toMatchObject({
      oid,
      email: 'renamed.after@defra.gov.uk',
      displayName: 'Renamed User'
    })
    expect(await server.db.collection('users').countDocuments({ oid })).toBe(1)
  })

  test('PUT /v1/users/me never binds a record with the same email and no oid; it makes a new one', async () => {
    const { insertedId } = await server.db.collection('users').insertOne({
      email: 'legacy.user@defra.gov.uk',
      displayName: 'Legacy User',
      roles: ['research-user', 'platform-admin']
    })
    const oid = randomUUID()

    const { result } = await signIn({ oid, email: 'legacy.user@defra.gov.uk' })

    expect(result.user._id.toString()).not.toBe(insertedId.toString())
    expect(result.user).toMatchObject({
      oid,
      tid: TENANT_ID,
      roles: ['research-user']
    })
    expect(await usersWithEmail('legacy.user@defra.gov.uk')).toHaveLength(2)
    expect(
      await server.db.collection('users').findOne({ _id: insertedId })
    ).not.toHaveProperty('oid')
  })

  test('PUT /v1/users/me changes no membership, even with an old invited row for the same email', async () => {
    const { insertedId } = await server.db.collection('teamMembers').insertOne({
      teamId: 'team-with-old-invitation',
      userId: null,
      email: 'old.invitee@defra.gov.uk',
      role: 'admin',
      status: 'invited'
    })

    const { result } = await signIn({ email: 'old.invitee@defra.gov.uk' })

    expect(result.user.email).toBe('old.invitee@defra.gov.uk')
    expect(
      await server.db.collection('teamMembers').findOne({ _id: insertedId })
    ).toMatchObject({ userId: null, status: 'invited' })
    expect(
      await server.db
        .collection('teamMembers')
        .countDocuments({ userId: result.user._id.toString() })
    ).toBe(0)
  })

  test('PUT /v1/users/me returns the record an Admin made from the directory, and keeps one', async () => {
    const oid = randomUUID()
    const { insertedId } = await server.db.collection('users').insertOne({
      oid,
      tid: TENANT_ID,
      email: 'directory.person@defra.gov.uk',
      displayName: 'Directory Person',
      roles: ['research-user']
    })

    const { result } = await signIn({
      oid,
      email: 'directory.person@defra.gov.uk',
      name: 'Directory Person'
    })

    expect(result.user._id.toString()).toBe(insertedId.toString())
    expect(result.user.lastSignInAt).toEqual(expect.any(String))
    expect(await server.db.collection('users').countDocuments({ oid })).toBe(1)
  })

  test('PUT /v1/users/me leaves the sign-in decision to the token: the tenant and account checks, not an email domain', async () => {
    const { result, statusCode } = await signIn({
      email: 'contractor@example.com'
    })

    expect(statusCode).toBe(200)
    expect(result.user.email).toBe('contractor@example.com')
  })

  test('PUT /v1/users/me gives another identity with the same email its own record', async () => {
    const first = await signIn({ email: 'rejoiner@defra.gov.uk' })
    const second = await signIn({ email: 'rejoiner@defra.gov.uk' })

    expect(second.statusCode).toBe(200)
    expect(second.result.user._id.toString()).not.toBe(
      first.result.user._id.toString()
    )
    expect(await usersWithEmail('rejoiner@defra.gov.uk')).toHaveLength(2)
  })

  test('PUT /v1/users/me takes the person from the token and never from a body', async () => {
    const oid = randomUUID()
    const impostor = randomUUID()

    const { result, statusCode } = await server.inject({
      method: 'PUT',
      url: '/v1/users/me',
      headers: bearer(
        delegatedClaims({
          oid,
          name: 'Token Person',
          email: 'token.person@defra.gov.uk'
        })
      ),
      payload: {
        oid: impostor,
        tid: randomUUID(),
        email: 'body.person@defra.gov.uk',
        displayName: 'Body Person',
        roles: ['platform-admin']
      }
    })

    expect(statusCode).toBe(200)
    expect(result.user).toMatchObject({
      oid,
      email: 'token.person@defra.gov.uk',
      displayName: 'Token Person',
      roles: ['research-user']
    })
    expect(
      await server.db.collection('users').countDocuments({ oid: impostor })
    ).toBe(0)
  })

  test('PUT /v1/users/me ignores a body that is not even JSON', async () => {
    const { statusCode } = await server.inject({
      method: 'PUT',
      url: '/v1/users/me',
      headers: {
        ...bearer(
          delegatedClaims({
            oid: randomUUID(),
            name: 'Odd Body',
            email: 'odd.body@defra.gov.uk'
          })
        ),
        'content-type': 'application/json'
      },
      payload: '{not json'
    })

    expect(statusCode).toBe(200)
  })

  test('PUT /v1/users/me keeps a display name to 100 characters', async () => {
    const { result } = await signIn({
      name: 'N'.repeat(150),
      email: 'long.name@defra.gov.uk'
    })

    expect(result.user.displayName).toHaveLength(100)
  })

  test('PUT /v1/users/me audits the sign-in with the token fields and no token', async () => {
    const oid = randomUUID()
    const { result } = await signIn({
      oid,
      uti: 'sign-in-uti',
      email: 'audited.user@defra.gov.uk'
    })

    const event = await server.db.collection('auditEvents').findOne({
      action: 'user.signIn',
      resourceId: result.user._id.toString()
    })

    expect(event).toMatchObject({
      actorUserId: result.user._id.toString(),
      oid,
      tid: TENANT_ID,
      azp: FRONTEND_CLIENT_ID,
      uti: 'sign-in-uti',
      outcome: 'success'
    })
    expect(JSON.stringify(event)).not.toContain('eyJ')
  })

  describe('a token that must not sign anyone in', () => {
    async function expectNoRecordFor(oid, response) {
      expect(response.statusCode).toBe(401)
      expect(response.result.code).toBe('invalid-token')
      expect(await server.db.collection('users').countDocuments({ oid })).toBe(
        0
      )
    }

    test("another tenant's token creates no record", async () => {
      const oid = randomUUID()

      await expectNoRecordFor(oid, await signIn({ oid, tid: randomUUID() }))
    })

    test("a guest's token creates no record", async () => {
      const oid = randomUUID()

      await expectNoRecordFor(oid, await signIn({ oid, acct: 1 }))
    })

    test('the frontend app-only token creates no record', async () => {
      const response = await server.inject({
        method: 'PUT',
        url: '/v1/users/me',
        headers: bearer(appClaims())
      })

      expect(response.statusCode).toBe(401)
    })

    test.each([
      ['no email claim', { email: undefined }],
      ['no name claim', { name: undefined }]
    ])('a token with %s creates no record', async (_name, claims) => {
      const oid = randomUUID()

      await expectNoRecordFor(oid, await signIn({ oid, ...claims }))
    })

    test('an object ID in capitals creates no record', async () => {
      const oid = randomUUID()

      await expectNoRecordFor(
        oid.toUpperCase(),
        await signIn({ oid: oid.toUpperCase() })
      )
    })
  })

  test('x-user-id alone no longer signs anyone in or reads anyone', async () => {
    const put = await server.inject({
      method: 'PUT',
      url: '/v1/users/me',
      headers: { 'x-user-id': '507f1f77bcf86cd799439011' }
    })
    const get = await server.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { 'x-user-id': '507f1f77bcf86cd799439011' }
    })

    expect(put.statusCode).toBe(401)
    expect(get.statusCode).toBe(401)
  })

  test('POST /v1/users is gone', async () => {
    const { statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(delegatedClaims({ oid: randomUUID() })),
      payload: {
        oid: randomUUID(),
        tid: TENANT_ID,
        email: 'someone@defra.gov.uk',
        displayName: 'Someone'
      }
    })

    expect(statusCode).toBe(404)
  })

  describe('isPlatformAdmin', () => {
    // A person the portal's database holds as a Platform Admin.
    async function makePlatformAdmin(oid, email) {
      await server.db.collection('users').insertOne({
        oid,
        tid: TENANT_ID,
        email,
        displayName: 'Admin Person',
        roles: ['research-user', 'platform-admin']
      })
    }

    function getMe(oid) {
      return server.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: bearer(delegatedClaims({ oid }))
      })
    }

    test('PUT and GET /v1/users/me say true for a person holding the platform-admin role', async () => {
      const oid = randomUUID()

      await makePlatformAdmin(oid, 'is.admin@defra.gov.uk')

      expect((await signIn({ oid })).result.isPlatformAdmin).toBe(true)
      expect((await getMe(oid)).result.isPlatformAdmin).toBe(true)
    })

    test('PUT and GET /v1/users/me say false for everyone else, a new person included', async () => {
      const oid = randomUUID()

      expect((await signIn({ oid })).result.isPlatformAdmin).toBe(false)
      expect((await getMe(oid)).result.isPlatformAdmin).toBe(false)
    })

    test('says false at the next call once the role is removed, with no new sign-in', async () => {
      const oid = randomUUID()

      await makePlatformAdmin(oid, 'was.admin@defra.gov.uk')
      expect((await getMe(oid)).result.isPlatformAdmin).toBe(true)

      await server.db
        .collection('users')
        .updateOne({ oid }, { $set: { roles: ['research-user'] } })

      expect((await getMe(oid)).result.isPlatformAdmin).toBe(false)
      expect((await signIn({ oid })).result.isPlatformAdmin).toBe(false)
    })
  })

  describe('GET /v1/users/me', () => {
    test('returns the person the token describes, with no team yet', async () => {
      const oid = randomUUID()
      const signedIn = await signIn({ oid, email: 'me.user@defra.gov.uk' })

      const { result, statusCode } = await server.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: bearer(delegatedClaims({ oid }))
      })

      expect(statusCode).toBe(200)
      expect(result.user._id.toString()).toBe(
        signedIn.result.user._id.toString()
      )
      expect(result.user.email).toBe('me.user@defra.gov.uk')
      expect(result.team).toBeNull()
    })

    test('ignores an x-user-id naming someone else', async () => {
      const mine = await signIn({ email: 'mine@defra.gov.uk' })
      const theirs = await signIn({ email: 'theirs@defra.gov.uk' })

      const { result } = await server.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: {
          ...bearer(delegatedClaims({ oid: mine.result.user.oid })),
          'x-user-id': theirs.result.user._id.toString()
        }
      })

      expect(result.user.email).toBe('mine@defra.gov.uk')
    })

    test('refuses a person who has not signed in yet', async () => {
      const { statusCode } = await server.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: bearer(delegatedClaims({ oid: randomUUID() }))
      })

      expect(statusCode).toBe(401)
    })
  })
})
