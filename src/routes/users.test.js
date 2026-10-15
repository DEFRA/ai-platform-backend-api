import { randomUUID } from 'node:crypto'

const TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'

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

  function signIn(payload) {
    return server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: randomUUID(),
        tid: TENANT_ID,
        displayName: 'Test User',
        ...payload
      }
    })
  }

  function usersWithEmail(email) {
    return server.db.collection('users').find({ email }).toArray()
  }

  test('POST /v1/users upserts a user keyed on their Entra object and tenant IDs', async () => {
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
      roles: ['research-user']
    })
    expect(result.team).toBeNull()
  })

  test('POST /v1/users keeps one record per identity and refreshes its display fields', async () => {
    const oid = randomUUID()
    const first = await signIn({ oid, email: 'renamed.before@defra.gov.uk' })
    const second = await signIn({
      oid: oid.toUpperCase(),
      email: 'Renamed.After@defra.gov.uk',
      displayName: 'Renamed User'
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

  test('POST /v1/users binds a record from before oid keying to the identity on first sign-in', async () => {
    const { insertedId } = await server.db.collection('users').insertOne({
      email: 'legacy.user@defra.gov.uk',
      displayName: 'Legacy User',
      roles: ['research-user', 'platform-admin']
    })
    const oid = randomUUID()

    const { result } = await signIn({ oid, email: 'legacy.user@defra.gov.uk' })

    expect(result.user._id.toString()).toBe(insertedId.toString())
    expect(result.user).toMatchObject({
      oid,
      tid: TENANT_ID,
      roles: ['research-user', 'platform-admin']
    })
    expect(await usersWithEmail('legacy.user@defra.gov.uk')).toHaveLength(1)
  })

  test('POST /v1/users gives another identity with the same email its own record', async () => {
    const first = await signIn({ email: 'rejoiner@defra.gov.uk' })
    const second = await signIn({ email: 'rejoiner@defra.gov.uk' })

    expect(second.statusCode).toBe(200)
    expect(second.result.user._id.toString()).not.toBe(
      first.result.user._id.toString()
    )
    expect(await usersWithEmail('rejoiner@defra.gov.uk')).toHaveLength(2)
  })

  test('POST /v1/users rejects disallowed email domains', async () => {
    const { result, statusCode } = await signIn({
      email: 'test.user@example.com'
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('domain-not-allowed')
  })

  test.each([
    ['a missing oid', { oid: undefined }],
    ['a missing tid', { tid: undefined }],
    ['an oid that is not a GUID', { oid: 'not-a-guid' }],
    ['a braced tid', { tid: `{${TENANT_ID}}` }]
  ])('POST /v1/users rejects %s', async (_, payload) => {
    const { statusCode } = await signIn({
      email: 'invalid.identity@defra.gov.uk',
      ...payload
    })

    expect(statusCode).toBe(400)
  })

  test('POST /v1/users rejects unknown payload keys', async () => {
    const { statusCode } = await signIn({
      email: 'test.user@defra.gov.uk',
      teamName: 'not-allowed'
    })

    expect(statusCode).toBe(400)
  })

  test('GET /v1/users/me returns the current user with no team yet', async () => {
    const signedIn = await signIn({ email: 'me.user@defra.gov.uk' })

    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { 'x-user-id': signedIn.result.user._id.toString() }
    })

    expect(statusCode).toBe(200)
    expect(result.user.email).toBe('me.user@defra.gov.uk')
    expect(result.team).toBeNull()
  })

  test('GET /v1/users/me returns 404 for an unknown user id', async () => {
    const { statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { 'x-user-id': '507f1f77bcf86cd799439011' }
    })

    expect(statusCode).toBe(404)
  })
})
