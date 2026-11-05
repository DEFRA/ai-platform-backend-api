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

  test('POST /v1/users never binds a record with the same email and no oid; it makes a new one', async () => {
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

  test('POST /v1/users changes no membership, even with an old invited row for the same email', async () => {
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

  test('POST /v1/users returns the record an Admin made from the directory, and keeps one', async () => {
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
      displayName: 'Directory Person'
    })

    expect(result.user._id.toString()).toBe(insertedId.toString())
    expect(result.user.lastSignInAt).toEqual(expect.any(String))
    expect(await server.db.collection('users').countDocuments({ oid })).toBe(1)
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
    ['defra.gov.uk', 'test.user@defra.gov.uk'],
    ['defra.onmicrosoft.com', 'test.user@defra.onmicrosoft.com'],
    ['defra.onmicrosoft.com in any case', 'Test.User@DEFRA.OnMicrosoft.com']
  ])('POST /v1/users accepts an email on %s', async (_, email) => {
    const { result, statusCode } = await signIn({ email })

    expect(statusCode).toBe(200)
    expect(result.user.email).toBe(email.toLowerCase())
  })

  test.each([
    ['a guest', 'test.user_example.com#EXT#@defra.onmicrosoft.com'],
    ['a guest in any case', 'test.user_example.com#ext#@DEFRA.onmicrosoft.com'],
    ['a subdomain', 'test.user@mail.defra.gov.uk'],
    ['a subdomain of the tenant domain', 'test.user@x.defra.onmicrosoft.com'],
    ['a look-alike prefix', 'test.user@notdefra.gov.uk'],
    ['a look-alike suffix', 'test.user@defra.gov.uk.example.com'],
    ['a look-alike tenant', 'test.user@defra.onmicrosoft.com.example.com'],
    ['another tenant', 'test.user@other.onmicrosoft.com']
  ])('POST /v1/users refuses an email that is %s', async (_, email) => {
    const { result, statusCode } = await signIn({ email })

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
