import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

const ENTRA_TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'

// People the mock directory holds (src/adapters/fixtures/directory-people.json).
const SEEDED = {
  journey: '5eed0000-0000-4000-8000-000000000001',
  amelia: '5eed0000-0000-4000-8000-000000000002',
  bashir: '5eed0000-0000-4000-8000-000000000003',
  cerys: '5eed0000-0000-4000-8000-000000000004',
  daniel: '5eed0000-0000-4000-8000-000000000005',
  eleanor: '5eed0000-0000-4000-8000-000000000006',
  farid: '5eed0000-0000-4000-8000-000000000007',
  grace: '5eed0000-0000-4000-8000-000000000008',
  supplier: '5eed0000-0000-4000-8000-000000000009',
  guest: '5eed0000-0000-4000-8000-00000000000a',
  lookalike: '5eed0000-0000-4000-8000-00000000000b'
}

describe('#teams routes', () => {
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

  function postHeaders(userId) {
    return { 'x-user-id': userId, 'idempotency-key': randomUUID() }
  }

  // A person who has signed in, as sign-in makes them; returns their
  // x-user-id, which is their `users` id.
  async function signInAs(label) {
    const { result } = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: randomUUID(),
        tid: ENTRA_TENANT_ID,
        email: `${label}@defra.gov.uk`,
        displayName: `Admin ${label}`
      }
    })

    return result.user._id.toString()
  }

  // A team created by a person who has signed in, so they can add people.
  async function teamWithAdmin(label) {
    const adminId = await signInAs(label)
    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: postHeaders(adminId),
      payload: {
        name: `Team ${label} ${randomUUID().slice(0, 8)}`,
        serviceCode: 'ABC'
      }
    })

    return {
      adminId,
      teamId: created.result.team._id.toString(),
      slug: created.result.team.slug
    }
  }

  // Role is always stated, as the API requires; a test of a missing role posts
  // with `server.inject` itself.
  function addPerson(team, actorId, payload, by = 'id') {
    return server.inject({
      method: 'POST',
      url: `/v1/teams/${by === 'slug' ? team.slug : team.teamId}/members`,
      headers: postHeaders(actorId),
      payload: { role: 'user', ...payload }
    })
  }

  // Adds a seeded person and returns the member as the API shows it.
  async function addSeeded(team, person, role = 'user') {
    const { result, statusCode } = await addPerson(team, team.adminId, {
      oid: SEEDED[person],
      role
    })

    expect(statusCode).toBe(201)

    return result.member
  }

  // A fixture for tests of what members can do, not of how they are added: a
  // signed-in person who is already an active member, written straight to the
  // database so the team's creator need not be a real person.
  async function insertActiveMember(teamId, label, role = 'user') {
    const now = new Date().toISOString()
    const { insertedId } = await server.db.collection('users').insertOne({
      oid: randomUUID(),
      tid: ENTRA_TENANT_ID,
      email: `${label}@defra.gov.uk`,
      displayName: 'Fixture Member',
      roles: ['research-user'],
      createdAt: now
    })
    const userId = insertedId.toString()

    await server.db
      .collection('teamMembers')
      .insertOne({ teamId, userId, role, status: 'active', createdAt: now })

    return { userId }
  }

  test('POST /v1/teams creates a team and makes the creator an admin', async () => {
    const { result, statusCode, headers } = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: {
        'x-user-id': 'team-user-1',
        'idempotency-key': randomUUID()
      },
      payload: { name: 'Flood Risk Team', serviceCode: 'ABC' }
    })

    expect(statusCode).toBe(201)
    expect(headers.location).toBe(`/v1/teams/${result.team._id}`)
    expect(result.team.normalisedName).toBe('flood-risk-team')
    expect(result.team.slug).toBe('flood-risk-team')
    expect(result.team.serviceCode).toBe('ABC')
    expect(result.team.verified).toBe(false)
  })

  test('POST /v1/teams stores the service code in upper case', async () => {
    const { result } = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: postHeaders('team-service-code-user'),
      payload: { name: 'Lower Case Code Team', serviceCode: 'a1b' }
    })

    expect(result.team.serviceCode).toBe('A1B')
  })

  test.each([
    ['no service code', {}],
    ['a code that is not three characters', { serviceCode: 'AB' }],
    ['a code with punctuation', { serviceCode: 'A-B' }]
  ])('POST /v1/teams refuses %s', async (_, payload) => {
    const { statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: postHeaders('team-service-code-user'),
      payload: { name: 'Bad Service Code Team', ...payload }
    })

    expect(statusCode).toBe(400)
  })

  test('PATCH /v1/teams/{id} lets an admin set the service code and re-verifies it', async () => {
    const headers = postHeaders('team-patch-admin')
    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'Service Code Change Team', serviceCode: 'ABC' }
    })
    const teamId = created.result.team._id.toString()

    const { result, statusCode } = await server.inject({
      method: 'PATCH',
      url: `/v1/teams/${teamId}`,
      headers: { 'x-user-id': 'team-patch-admin' },
      payload: { serviceCode: 'xyz' }
    })

    expect(statusCode).toBe(200)
    expect(result.team.serviceCode).toBe('XYZ')
    expect(result.team.verified).toBe(false)
  })

  test('PATCH /v1/teams/{id} refuses a member who is not an admin', async () => {
    const team = await teamWithAdmin('team-patch-admin-2')
    const member = await addSeeded(team, 'amelia')

    const { statusCode } = await server.inject({
      method: 'PATCH',
      url: `/v1/teams/${team.teamId}`,
      headers: { 'x-user-id': member.userId },
      payload: { serviceCode: 'XYZ' }
    })

    expect(statusCode).toBe(403)
  })

  test('PATCH /v1/teams/{id} is not found for someone outside the team', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: postHeaders('team-patch-admin-3'),
      payload: { name: 'Service Code Stranger Team', serviceCode: 'ABC' }
    })

    const { statusCode } = await server.inject({
      method: 'PATCH',
      url: `/v1/teams/${created.result.team._id}`,
      headers: { 'x-user-id': 'not-a-member' },
      payload: { serviceCode: 'XYZ' }
    })

    expect(statusCode).toBe(404)
  })

  test('POST /v1/teams numbers the slug when a differently punctuated name derives the same one', async () => {
    const first = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: postHeaders('team-slug-user'),
      payload: { name: 'Coastal Erosion', serviceCode: 'ABC' }
    })
    const second = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: postHeaders('team-slug-user'),
      payload: { name: 'Coastal Erosion!', serviceCode: 'ABC' }
    })

    expect(first.result.team.slug).toBe('coastal-erosion')
    expect(second.statusCode).toBe(201)
    expect(second.result.team.slug).toBe('coastal-erosion-2')
  })

  test('POST /v1/teams replays without creating a duplicate for a repeated Idempotency-Key', async () => {
    const idempotencyKey = randomUUID()
    const headers = {
      'x-user-id': 'team-user-2',
      'idempotency-key': idempotencyKey
    }
    const payload = { name: 'Replay Team', serviceCode: 'ABC' }

    const first = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload
    })
    const second = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload
    })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)
    expect(second.result.team._id.toString()).toBe(
      first.result.team._id.toString()
    )
  })

  test('POST /v1/teams creates only one team when the same Idempotency-Key is sent concurrently', async () => {
    const headers = {
      'x-user-id': 'team-user-2b',
      'idempotency-key': randomUUID()
    }

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        server.inject({
          method: 'POST',
          url: '/v1/teams',
          headers,
          payload: { name: 'Concurrent Replay Team', serviceCode: 'ABC' }
        })
      )
    )

    const ids = new Set(
      responses.map((response) => response.result.team._id.toString())
    )

    expect(ids.size).toBe(1)
    expect(responses.every((response) => response.statusCode < 400)).toBe(true)
  })

  test('POST /v1/teams/{id}/members creates one membership when the same person is added concurrently', async () => {
    const team = await teamWithAdmin('team-user-2c')

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        addPerson(team, team.adminId, { oid: SEEDED.bashir })
      )
    )

    expect(
      responses.filter((response) => response.statusCode === 201)
    ).toHaveLength(1)
    expect(
      responses
        .filter((response) => response.statusCode !== 201)
        .map((response) => [response.statusCode, response.result.code])
    ).toEqual(Array(4).fill([409, 'member-exists']))

    const active = await server.db
      .collection('teamMembers')
      .find({ teamId: team.teamId, status: 'active' })
      .toArray()

    expect(active).toHaveLength(2)
    expect(
      await server.db
        .collection('users')
        .countDocuments({ oid: SEEDED.bashir, tid: ENTRA_TENANT_ID })
    ).toBe(1)
  })

  test('POST /v1/teams rejects a duplicate team name', async () => {
    const headers = {
      'x-user-id': 'team-user-3',
      'idempotency-key': randomUUID()
    }

    await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'Unique Team', serviceCode: 'ABC' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { name: 'Unique Team', serviceCode: 'ABC' }
    })

    expect(statusCode).toBe(409)
    expect(result.code).toBe('team-exists')
  })

  test('GET /v1/teams lists the teams the user is an active member of', async () => {
    const headers = {
      'x-user-id': 'team-user-4',
      'idempotency-key': randomUUID()
    }

    await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 4', serviceCode: 'ABC' }
    })

    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/teams',
      headers: { 'x-user-id': 'team-user-4' }
    })

    expect(statusCode).toBe(200)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].name).toBe('My Team 4')
    expect(result.items[0].role).toBe('admin')
  })

  test('GET /v1/teams returns role: user for an added member', async () => {
    const team = await teamWithAdmin('team-user-4b')
    const member = await addSeeded(team, 'cerys')

    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/teams',
      headers: { 'x-user-id': member.userId }
    })

    expect(statusCode).toBe(200)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].role).toBe('user')
  })

  test('GET /v1/teams/{id} returns the team and members for an active member', async () => {
    const headers = {
      'x-user-id': 'team-user-5',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 5', serviceCode: 'ABC' }
    })

    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${created.result.team._id}`,
      headers: { 'x-user-id': 'team-user-5' }
    })

    expect(statusCode).toBe(200)
    expect(result.team.name).toBe('My Team 5')
    expect(result.members).toHaveLength(1)
    expect(result.members[0].role).toBe('admin')
  })

  test('GET /v1/teams/{id} returns 404 for a non-member', async () => {
    const headers = {
      'x-user-id': 'team-user-6',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 6', serviceCode: 'ABC' }
    })

    const { statusCode } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${created.result.team._id}`,
      headers: { 'x-user-id': 'someone-else' }
    })

    expect(statusCode).toBe(404)
  })

  test('GET /v1/teams/{id} returns 404 for an unknown id', async () => {
    const { statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/teams/507f1f77bcf86cd799439011',
      headers: { 'x-user-id': 'team-user-6' }
    })

    expect(statusCode).toBe(404)
  })

  test('POST /v1/teams/{id}/members adds a member at once, with the user role and no email stored', async () => {
    const team = await teamWithAdmin('team-user-7')

    const { result, statusCode, headers } = await addPerson(
      team,
      team.adminId,
      { oid: SEEDED.amelia }
    )

    expect(statusCode).toBe(201)
    expect(headers.location).toBe(`/v1/teams/${team.teamId}/members`)
    expect(result.member).toEqual({
      _id: expect.anything(),
      teamId: team.teamId,
      userId: expect.any(String),
      displayName: 'Amelia Hartley',
      email: 'amelia.hartley@defra.gov.uk',
      role: 'user',
      status: 'active',
      createdAt: expect.any(String)
    })

    const stored = await server.db
      .collection('teamMembers')
      .findOne({ _id: result.member._id })

    expect(stored).not.toHaveProperty('email')
    expect(stored.status).toBe('active')
  })

  test('POST /v1/teams/{id}/members lists the team for the person added, with no sign-in', async () => {
    const team = await teamWithAdmin('team-user-7a')
    const member = await addSeeded(team, 'bashir')

    const { result } = await server.inject({
      method: 'GET',
      url: '/v1/teams',
      headers: { 'x-user-id': member.userId }
    })

    expect(result.items.map((item) => item._id.toString())).toContain(
      team.teamId
    )
  })

  test('POST /v1/teams/{id}/members makes one record for a person who has never signed in, which their first sign-in then finds', async () => {
    const team = await teamWithAdmin('team-user-10')
    const member = await addSeeded(team, 'daniel')
    const users = server.db.collection('users')

    const made = await users.findOne({ oid: SEEDED.daniel })

    expect(made).toMatchObject({
      tid: ENTRA_TENANT_ID,
      displayName: 'Daniel Okafor',
      email: 'daniel.okafor@defra.gov.uk',
      roles: ['research-user']
    })
    expect(made.lastSignInAt).toBeUndefined()
    expect(made._id.toString()).toBe(member.userId)

    const signIn = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: SEEDED.daniel,
        tid: ENTRA_TENANT_ID,
        email: 'daniel.okafor@defra.gov.uk',
        displayName: 'Daniel Okafor'
      }
    })
    const teams = await server.inject({
      method: 'GET',
      url: '/v1/teams',
      headers: { 'x-user-id': signIn.result.user._id.toString() }
    })

    expect(signIn.result.user._id.toString()).toBe(member.userId)
    expect(signIn.result.user.lastSignInAt).toEqual(expect.any(String))
    expect(
      await users.countDocuments({ oid: SEEDED.daniel, tid: ENTRA_TENANT_ID })
    ).toBe(1)
    expect(teams.result.items.map((item) => item._id.toString())).toContain(
      team.teamId
    )
  })

  test('POST /v1/teams/{id}/members leaves the record of a person who has already signed in as it is', async () => {
    const team = await teamWithAdmin('team-user-10b')
    const signedIn = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: SEEDED.eleanor,
        tid: ENTRA_TENANT_ID,
        email: 'eleanor.own.address@defra.gov.uk',
        displayName: 'Eleanor Own Name'
      }
    })

    const member = await addSeeded(team, 'eleanor')

    expect(member.userId).toBe(signedIn.result.user._id.toString())
    expect(member.displayName).toBe('Eleanor Own Name')
    expect(member.email).toBe('eleanor.own.address@defra.gov.uk')
  })

  test('POST /v1/teams/{id}/members takes the email from the user principal name when the person has no mail', async () => {
    const team = await teamWithAdmin('team-user-7b2')

    const member = await addSeeded(team, 'farid')

    expect(member.email).toBe('farid.haidari@defra.onmicrosoft.com')
  })

  test('POST /v1/teams/{id}/members rejects adding the same person twice', async () => {
    const team = await teamWithAdmin('team-user-7b')

    await addSeeded(team, 'grace')
    const { result, statusCode } = await addPerson(team, team.adminId, {
      oid: SEEDED.grace
    })

    expect(statusCode).toBe(409)
    expect(result.code).toBe('member-exists')
  })

  test('POST /v1/teams/{id}/members replays the same membership for the same Idempotency-Key', async () => {
    const team = await teamWithAdmin('team-user-7c')
    const headers = postHeaders(team.adminId)
    const add = () =>
      server.inject({
        method: 'POST',
        url: `/v1/teams/${team.teamId}/members`,
        headers,
        payload: { oid: SEEDED.journey, role: 'admin' }
      })

    const first = await add()
    const second = await add()

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(second.result.member).toEqual(first.result.member)
    expect(
      await server.db
        .collection('teamMembers')
        .countDocuments({ teamId: team.teamId, status: 'active' })
    ).toBe(2)
  })

  test('POST /v1/teams/{id}/members refuses a reused Idempotency-Key for another person or role, and adds nobody (F2)', async () => {
    const team = await teamWithAdmin('team-f2')
    const headers = postHeaders(team.adminId)
    const post = (payload) =>
      server.inject({
        method: 'POST',
        url: `/v1/teams/${team.teamId}/members`,
        headers,
        payload
      })

    const first = await post({ oid: SEEDED.daniel, role: 'user' })
    const otherPerson = await post({ oid: SEEDED.eleanor, role: 'user' })
    const otherRole = await post({ oid: SEEDED.daniel, role: 'admin' })
    const same = await post({ oid: SEEDED.daniel, role: 'user' })

    expect(first.statusCode).toBe(201)
    expect(otherPerson.statusCode).toBe(409)
    expect(otherPerson.result.code).toBe('idempotency-key-reused')
    expect(otherRole.statusCode).toBe(409)
    expect(otherRole.result.code).toBe('idempotency-key-reused')
    expect(same.statusCode).toBe(201)
    expect(same.result.member).toEqual(first.result.member)
    expect(
      await server.db
        .collection('teamMembers')
        .countDocuments({ teamId: team.teamId, status: 'active' })
    ).toBe(2)
  })

  test('POST /v1/teams/{id}/members lets a person who was removed be added again', async () => {
    const team = await teamWithAdmin('team-user-7d')
    const first = await addSeeded(team, 'amelia')

    await server.inject({
      method: 'DELETE',
      url: `/v1/teams/${team.teamId}/members/${first._id}`,
      headers: { 'x-user-id': team.adminId }
    })
    const again = await addPerson(team, team.adminId, { oid: SEEDED.amelia })

    expect(again.statusCode).toBe(201)
    expect(again.result.member._id.toString()).not.toBe(first._id.toString())
    expect(again.result.member.userId).toBe(first.userId)
  })

  test.each([
    ['a supplier', 'supplier'],
    ['a guest', 'guest'],
    ['a look-alike domain', 'lookalike']
  ])(
    'POST /v1/teams/{id}/members refuses %s as not eligible',
    async (_, person) => {
      const team = await teamWithAdmin(`team-not-eligible-${person}`)

      const { result, statusCode } = await addPerson(team, team.adminId, {
        oid: SEEDED[person]
      })

      expect(statusCode).toBe(422)
      expect(result.code).toBe('person-not-eligible')
      expect(
        await server.db
          .collection('users')
          .countDocuments({ oid: SEEDED[person] })
      ).toBe(0)
    }
  )

  test('POST /v1/teams/{id}/members refuses an unknown oid exactly as it refuses an ineligible person', async () => {
    const team = await teamWithAdmin('team-unknown-oid')

    const unknown = await addPerson(team, team.adminId, { oid: randomUUID() })
    const ineligible = await addPerson(team, team.adminId, {
      oid: SEEDED.supplier
    })

    expect(unknown.statusCode).toBe(422)
    expect({ ...unknown.result, requestId: undefined }).toEqual({
      ...ineligible.result,
      requestId: undefined
    })
    expect(unknown.result.code).toBe('person-not-eligible')
  })

  test.each([
    ['an email, as before', { email: 'someone@defra.gov.uk' }],
    ['no oid', { role: 'user' }],
    ['an oid that is not a GUID', { oid: 'not-a-guid' }],
    ['a role it does not know', { oid: SEEDED.amelia, role: 'owner' }],
    ['an unknown key', { oid: SEEDED.amelia, name: 'Someone' }]
  ])('POST /v1/teams/{id}/members refuses %s', async (_, payload) => {
    const team = await teamWithAdmin('team-bad-body')

    const { statusCode } = await addPerson(team, team.adminId, payload)

    expect(statusCode).toBe(400)
  })

  test('POST /v1/teams/{id}/members refuses a missing or malformed Idempotency-Key', async () => {
    const team = await teamWithAdmin('team-no-key')

    const missing = await server.inject({
      method: 'POST',
      url: `/v1/teams/${team.teamId}/members`,
      headers: { 'x-user-id': team.adminId },
      payload: { oid: SEEDED.amelia }
    })

    expect(missing.statusCode).toBe(400)
  })

  test('POST /v1/teams/{id}/members accepts an upper-case oid and stores it in lower case', async () => {
    const team = await teamWithAdmin('team-upper-oid')

    const { statusCode, result } = await addPerson(team, team.adminId, {
      oid: SEEDED.cerys.toUpperCase()
    })

    expect(statusCode).toBe(201)
    expect(
      await server.db.collection('users').countDocuments({ oid: SEEDED.cerys })
    ).toBe(1)
    expect(result.member.displayName).toBe('Cerys Owen')
  })

  test('POST /v1/teams/{id}/members asks the person to sign in again when the actor has no tenant', async () => {
    const team = await teamWithAdmin('team-no-tenant')

    await server.db
      .collection('users')
      .updateOne({ _id: new ObjectId(team.adminId) }, { $unset: { tid: '' } })
    const { result, statusCode } = await addPerson(team, team.adminId, {
      oid: SEEDED.amelia
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('entra-identity-required')
  })

  test('POST /v1/teams/{id}/members audits who added whom by object ID, never a name or email', async () => {
    const team = await teamWithAdmin('team-audit')

    await addSeeded(team, 'journey', 'admin')

    const [event] = await server.db
      .collection('auditEvents')
      .find({ resourceId: team.teamId, action: 'team.addMember' })
      .toArray()

    expect(event).toMatchObject({
      actorUserId: team.adminId,
      outcome: 'success',
      code: 'admin',
      subjectOid: SEEDED.journey
    })
    expect(JSON.stringify(event)).not.toMatch(/Journey|@defra/)
  })

  test('POST /v1/teams/{id}/members gives 503 directory-unavailable when the directory fails, and adds nobody', async () => {
    const team = await teamWithAdmin('team-directory-down')
    const { mockDirectory } = await import('#/adapters/mock-directory.js')
    const { boomWithCode, Boom } =
      await import('#/common/helpers/boom-with-code.js')

    vi.spyOn(mockDirectory, 'getPerson').mockRejectedValue(
      boomWithCode(
        Boom.serverUnavailable,
        'The directory is unavailable',
        'directory-unavailable'
      )
    )

    const { result, statusCode } = await addPerson(team, team.adminId, {
      oid: SEEDED.amelia
    })

    vi.restoreAllMocks()

    expect(statusCode).toBe(503)
    expect(result.code).toBe('directory-unavailable')
    expect(
      await server.db
        .collection('teamMembers')
        .countDocuments({ teamId: team.teamId })
    ).toBe(1)
  })

  test('POST /v1/teams/{id}/members rejects a non-admin member', async () => {
    const team = await teamWithAdmin('team-user-8')
    const boundMember = await addSeeded(team, 'bashir')

    const { result, statusCode } = await addPerson(team, boundMember.userId, {
      oid: SEEDED.cerys
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('admin-required')
  })

  test('POST /v1/teams/{id}/members returns 404 for a non-member actor', async () => {
    const team = await teamWithAdmin('team-user-9')
    const stranger = await signInAs('team-user-9-stranger')

    const { statusCode } = await addPerson(team, stranger, {
      oid: SEEDED.amelia
    })

    expect(statusCode).toBe(404)
  })

  test('GET /v1/teams/{id} shows a member\u2019s own name and email once they have signed in', async () => {
    const team = await teamWithAdmin('team-user-11')
    const member = await addSeeded(team, 'eleanor')

    await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: SEEDED.eleanor,
        tid: ENTRA_TENANT_ID,
        email: 'Eleanor.Signed.In@defra.gov.uk',
        displayName: 'Eleanor Signed In'
      }
    })

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${team.teamId}`,
      headers: { 'x-user-id': team.adminId }
    })

    expect(
      result.members.find((one) => one.userId === member.userId)
    ).toMatchObject({
      displayName: 'Eleanor Signed In',
      email: 'eleanor.signed.in@defra.gov.uk',
      status: 'active'
    })
  })

  test('GET /v1/teams/{id} shows the directory name and email of a member who has not signed in yet', async () => {
    const team = await teamWithAdmin('team-user-11b')
    const member = await addSeeded(team, 'grace')

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${team.teamId}`,
      headers: { 'x-user-id': team.adminId }
    })

    expect(
      result.members.find((one) => one.userId === member.userId)
    ).toMatchObject({
      displayName: 'Grace Lindqvist',
      email: 'grace.lindqvist@defra.gov.uk'
    })
  })

  test('DELETE /v1/teams/{id}/members/{memberId} lets an admin remove a member', async () => {
    const team = await teamWithAdmin('team-user-12')
    const added = await addSeeded(team, 'amelia')

    const { statusCode } = await server.inject({
      method: 'DELETE',
      url: `/v1/teams/${team.teamId}/members/${added._id}`,
      headers: { 'x-user-id': team.adminId }
    })

    expect(statusCode).toBe(204)

    const view = await server.inject({
      method: 'GET',
      url: `/v1/teams/${team.teamId}`,
      headers: { 'x-user-id': team.adminId }
    })

    expect(
      view.result.members.find((member) => member.userId === added.userId)
    ).toBeUndefined()
    expect(
      await server.db
        .collection('teamMembers')
        .findOne({ _id: added._id }, { projection: { status: 1 } })
    ).toMatchObject({ status: 'removed' })
  })

  test('GET /v1/teams/{id} lists only active members, never removed or invited rows (F3)', async () => {
    const team = await teamWithAdmin('team-f3')
    const kept = await addSeeded(team, 'bashir')
    const gone = await addSeeded(team, 'cerys')

    await server.inject({
      method: 'DELETE',
      url: `/v1/teams/${team.teamId}/members/${gone._id}`,
      headers: { 'x-user-id': team.adminId }
    })
    await server.db.collection('teamMembers').insertOne({
      teamId: team.teamId,
      userId: null,
      role: 'user',
      status: 'invited'
    })

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${team.teamId}`,
      headers: { 'x-user-id': team.adminId }
    })

    expect(result.members.map((member) => member.status)).toEqual([
      'active',
      'active'
    ])
    expect(result.members.map((member) => member.userId).sort()).toEqual(
      [team.adminId, kept.userId].sort()
    )
  })

  test('DELETE /v1/teams/{id}/members/{memberId} finds no membership that was never active', async () => {
    const team = await teamWithAdmin('team-user-12b')
    const { insertedId } = await server.db.collection('teamMembers').insertOne({
      teamId: team.teamId,
      userId: null,
      role: 'user',
      status: 'invited'
    })

    const { statusCode } = await server.inject({
      method: 'DELETE',
      url: `/v1/teams/${team.teamId}/members/${insertedId}`,
      headers: { 'x-user-id': team.adminId }
    })

    expect(statusCode).toBe(404)
  })

  test('DELETE /v1/teams/{id}/members/{memberId} rejects a non-admin', async () => {
    const team = await teamWithAdmin('team-user-13')
    const nonAdminMember = await addSeeded(team, 'bashir')

    const { result, statusCode } = await server.inject({
      method: 'DELETE',
      url: `/v1/teams/${team.teamId}/members/${nonAdminMember._id}`,
      headers: { 'x-user-id': nonAdminMember.userId }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('admin-required')
  })

  test('DELETE /v1/teams/{id}/members/{memberId} refuses to remove the last admin', async () => {
    const headers = {
      'x-user-id': 'team-user-14',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 14', serviceCode: 'ABC' }
    })
    const teamId = created.result.team._id.toString()

    const team = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}`,
      headers: { 'x-user-id': 'team-user-14' }
    })
    const adminMember = team.result.members[0]

    const { result, statusCode } = await server.inject({
      method: 'DELETE',
      url: `/v1/teams/${teamId}/members/${adminMember._id}`,
      headers: { 'x-user-id': 'team-user-14' }
    })

    expect(statusCode).toBe(409)
    expect(result.code).toBe('last-admin')
  })

  test('DELETE /v1/teams/{id}/members/{memberId} returns 404 for a non-member actor', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: {
        'x-user-id': 'team-user-15',
        'idempotency-key': randomUUID()
      },
      payload: { name: 'My Team 15', serviceCode: 'ABC' }
    })
    const teamId = created.result.team._id.toString()

    const team = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}`,
      headers: { 'x-user-id': 'team-user-15' }
    })

    const { statusCode } = await server.inject({
      method: 'DELETE',
      url: `/v1/teams/${teamId}/members/${team.result.members[0]._id}`,
      headers: { 'x-user-id': 'someone-else-again' }
    })

    expect(statusCode).toBe(404)
  })

  describe('PATCH /v1/teams/{id}/members/{memberId}', () => {
    // A team with its creator as admin and a second, signed-in member.
    async function teamWithMember(label) {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/teams',
        headers: postHeaders(label),
        payload: { name: `Role Team ${label}`, serviceCode: 'ABC' }
      })
      const teamId = created.result.team._id.toString()
      const { userId } = await insertActiveMember(teamId, label)

      const team = await server.inject({
        method: 'GET',
        url: `/v1/teams/${teamId}`,
        headers: { 'x-user-id': label }
      })

      return {
        teamId,
        admin: team.result.members.find((member) => member.role === 'admin'),
        member: team.result.members.find((member) => member.userId === userId),
        memberUserId: userId
      }
    }

    test('promotes a member to admin', async () => {
      const { teamId, member } = await teamWithMember('role-user-1')

      const { result, statusCode } = await server.inject({
        method: 'PATCH',
        url: `/v1/teams/${teamId}/members/${member._id}`,
        headers: { 'x-user-id': 'role-user-1' },
        payload: { role: 'admin' }
      })

      expect(statusCode).toBe(200)
      expect(result.member.role).toBe('admin')
    })

    test('refuses to demote the last admin', async () => {
      const { teamId, admin } = await teamWithMember('role-user-2')

      const { result, statusCode } = await server.inject({
        method: 'PATCH',
        url: `/v1/teams/${teamId}/members/${admin._id}`,
        headers: { 'x-user-id': 'role-user-2' },
        payload: { role: 'user' }
      })

      expect(statusCode).toBe(409)
      expect(result.code).toBe('last-admin')
    })

    test('demotes an admin once the team has another one', async () => {
      const { teamId, admin, member, memberUserId } =
        await teamWithMember('role-user-3')

      await server.inject({
        method: 'PATCH',
        url: `/v1/teams/${teamId}/members/${member._id}`,
        headers: { 'x-user-id': 'role-user-3' },
        payload: { role: 'admin' }
      })

      const { result, statusCode } = await server.inject({
        method: 'PATCH',
        url: `/v1/teams/${teamId}/members/${admin._id}`,
        headers: { 'x-user-id': memberUserId },
        payload: { role: 'user' }
      })

      expect(statusCode).toBe(200)
      expect(result.member.role).toBe('user')
    })

    test('refuses a member who is not an admin', async () => {
      const { teamId, admin, memberUserId } =
        await teamWithMember('role-user-4')

      const { result, statusCode } = await server.inject({
        method: 'PATCH',
        url: `/v1/teams/${teamId}/members/${admin._id}`,
        headers: { 'x-user-id': memberUserId },
        payload: { role: 'user' }
      })

      expect(statusCode).toBe(403)
      expect(result.code).toBe('admin-required')
    })

    test('keeps at least one admin when two admins demote each other at once', async () => {
      const { teamId, admin, member, memberUserId } =
        await teamWithMember('role-user-5')

      await server.inject({
        method: 'PATCH',
        url: `/v1/teams/${teamId}/members/${member._id}`,
        headers: { 'x-user-id': 'role-user-5' },
        payload: { role: 'admin' }
      })

      await Promise.all([
        server.inject({
          method: 'PATCH',
          url: `/v1/teams/${teamId}/members/${member._id}`,
          headers: { 'x-user-id': 'role-user-5' },
          payload: { role: 'user' }
        }),
        server.inject({
          method: 'PATCH',
          url: `/v1/teams/${teamId}/members/${admin._id}`,
          headers: { 'x-user-id': memberUserId },
          payload: { role: 'user' }
        })
      ])

      const team = await server.inject({
        method: 'GET',
        url: `/v1/teams/${teamId}`,
        headers: { 'x-user-id': 'role-user-5' }
      })
      const admins = team.result.members.filter(
        (one) => one.role === 'admin' && one.status === 'active'
      )

      expect(admins).toHaveLength(1)
    })

    test('refuses a role it does not know', async () => {
      const { teamId, member } = await teamWithMember('role-user-6')

      const { statusCode } = await server.inject({
        method: 'PATCH',
        url: `/v1/teams/${teamId}/members/${member._id}`,
        headers: { 'x-user-id': 'role-user-6' },
        payload: { role: 'owner' }
      })

      expect(statusCode).toBe(400)
    })
  })

  describe('team details, member roles, slugs and limits', () => {
    // A team whose creator (the label, as x-user-id) is its admin.
    async function newTeam(label) {
      const created = await server.inject({
        method: 'POST',
        url: '/v1/teams',
        headers: postHeaders(label),
        payload: {
          name: `Dt ${label} ${randomUUID().slice(0, 6)}`,
          serviceCode: 'ABC'
        }
      })

      return {
        teamId: created.result.team._id.toString(),
        slug: created.result.team.slug
      }
    }

    // An active, signed-in member; returns their user id, which is their
    // x-user-id.
    async function activeMember(team, label, role) {
      const { userId } = await insertActiveMember(team.teamId, label, role)

      return userId
    }

    function patch(team, userId, payload, by = 'id') {
      return server.inject({
        method: 'PATCH',
        url: `/v1/teams/${by === 'slug' ? team.slug : team.teamId}`,
        headers: { 'x-user-id': userId },
        payload
      })
    }

    describe('PATCH /v1/teams/{id} description', () => {
      test('lets an admin set it, trimmed, by id or by slug', async () => {
        const team = await newTeam('details-1')

        const byId = await patch(team, 'details-1', {
          description: '  Tracks flood risk  '
        })
        const bySlug = await patch(
          team,
          'details-1',
          { description: '  Flood risk models  ' },
          'slug'
        )

        expect(byId.statusCode).toBe(200)
        expect(byId.result.team.description).toBe('Tracks flood risk')
        expect(bySlug.statusCode).toBe(200)
        expect(bySlug.result.team.description).toBe('Flood risk models')
        expect(bySlug.result.team.serviceCode).toBe('ABC')
      })

      test.each([
        ['empty', ''],
        ['only spaces', '   ']
      ])('may be %s, which clears it', async (_, description) => {
        const team = await newTeam(`details-empty-${description.length}`)

        await patch(team, `details-empty-${description.length}`, {
          description: 'Something'
        })
        const { result, statusCode } = await patch(
          team,
          `details-empty-${description.length}`,
          { description }
        )

        expect(statusCode).toBe(200)
        expect(result.team.description).toBeNull()
      })

      test('allows 500 characters once trimmed and refuses 501', async () => {
        const team = await newTeam('details-2')

        const atLimit = await patch(team, 'details-2', {
          description: ` ${'a'.repeat(500)} `
        })
        const overLimit = await patch(team, 'details-2', {
          description: 'a'.repeat(501)
        })

        expect(atLimit.statusCode).toBe(200)
        expect(atLimit.result.team.description).toHaveLength(500)
        expect(overLimit.statusCode).toBe(400)
      })

      test('changes the service code and the description together', async () => {
        const team = await newTeam('details-3')

        const { result, statusCode } = await patch(team, 'details-3', {
          serviceCode: 'xyz',
          description: 'Both'
        })

        expect(statusCode).toBe(200)
        expect(result.team).toMatchObject({
          serviceCode: 'XYZ',
          description: 'Both'
        })

        const audit = await server.db
          .collection('auditEvents')
          .find({ resourceId: team.teamId })
          .toArray()

        expect(audit.map((event) => event.action)).toEqual(
          expect.arrayContaining(['team.setServiceCode', 'team.setDescription'])
        )
      })

      test.each([
        ['an unknown key', { description: 'Fine', name: 'Renamed' }],
        ['nothing to change', {}],
        ['a description that is not text', { description: 42 }]
      ])('refuses %s', async (_, payload) => {
        const team = await newTeam('details-4')

        const { statusCode } = await patch(team, 'details-4', payload)

        expect(statusCode).toBe(400)
      })

      test('refuses a member who is not an admin, by id and by slug', async () => {
        const team = await newTeam('details-5')
        const memberId = await activeMember(team, 'details-5')

        const byId = await patch(team, memberId, { description: 'Mine now' })
        const bySlug = await patch(
          team,
          memberId,
          { description: 'Mine now' },
          'slug'
        )
        const stored = await server.db
          .collection('teams')
          .findOne({ slug: team.slug })

        expect(byId.statusCode).toBe(403)
        expect(byId.result.code).toBe('admin-required')
        expect(bySlug.statusCode).toBe(403)
        expect(stored.description).toBeNull()
      })

      test('is not found for someone outside the team, and for an unknown slug', async () => {
        const team = await newTeam('details-6')

        const stranger = await patch(
          team,
          'details-stranger',
          { description: 'Mine now' },
          'slug'
        )
        const unknown = await server.inject({
          method: 'PATCH',
          url: '/v1/teams/no-such-team',
          headers: { 'x-user-id': 'details-6' },
          payload: { description: 'Nobody home' }
        })

        expect(stranger.statusCode).toBe(404)
        expect(unknown.statusCode).toBe(404)
      })
    })

    describe('POST /v1/teams/{id}/members role', () => {
      test('is required: a request with no role is refused, not defaulted (F6)', async () => {
        const team = await teamWithAdmin('role-default')

        const { result, statusCode } = await server.inject({
          method: 'POST',
          url: `/v1/teams/${team.teamId}/members`,
          headers: postHeaders(team.adminId),
          payload: { oid: SEEDED.amelia }
        })

        expect(statusCode).toBe(400)
        expect(result.message).toContain('"role" is required')
        expect(
          await server.db
            .collection('teamMembers')
            .countDocuments({ teamId: team.teamId })
        ).toBe(1)
      })

      test.each([
        ['admin', 'bashir'],
        ['user', 'cerys']
      ])('lets an admin add someone as %s, by slug', async (role, person) => {
        const team = await teamWithAdmin(`role-${role}`)

        const { result, statusCode, headers } = await addPerson(
          team,
          team.adminId,
          { oid: SEEDED[person], role },
          'slug'
        )

        expect(statusCode).toBe(201)
        expect(result.member.role).toBe(role)
        expect(headers.location).toBe(`/v1/teams/${team.slug}/members`)
      })

      test('makes an admin added from the directory an admin at once, with no sign-in', async () => {
        const team = await teamWithAdmin('role-signin')
        const added = await addSeeded(team, 'daniel', 'admin')

        const { statusCode } = await patch(team, added.userId, {
          description: 'Set by the added admin'
        })

        expect(statusCode).toBe(200)
      })

      test.each([
        ['a role it does not know', { role: 'owner' }],
        ['an unknown key', { role: 'user', name: 'Someone' }]
      ])('refuses %s', async (_, extra) => {
        const team = await teamWithAdmin('role-bad')

        const { statusCode } = await addPerson(team, team.adminId, {
          oid: SEEDED.amelia,
          ...extra
        })

        expect(statusCode).toBe(400)
      })

      test('refuses a member who is not an admin, even to add a user', async () => {
        const team = await teamWithAdmin('role-member')
        const member = await addSeeded(team, 'eleanor')

        const asAdmin = await addPerson(
          team,
          member.userId,
          { oid: SEEDED.amelia, role: 'admin' },
          'slug'
        )
        const asUser = await addPerson(team, member.userId, {
          oid: SEEDED.bashir
        })

        expect(asAdmin.statusCode).toBe(403)
        expect(asAdmin.result.code).toBe('admin-required')
        expect(asUser.statusCode).toBe(403)
      })

      test('is not found for someone outside the team, and for an unknown slug', async () => {
        const team = await teamWithAdmin('role-stranger')
        const outsider = await signInAs('role-outsider')

        const stranger = await addPerson(
          team,
          outsider,
          { oid: SEEDED.amelia, role: 'admin' },
          'slug'
        )
        const unknown = await addPerson(
          { slug: 'no-such-team' },
          team.adminId,
          { oid: SEEDED.amelia },
          'slug'
        )

        expect(stranger.statusCode).toBe(404)
        expect(unknown.statusCode).toBe(404)
      })
    })

    describe('a team addressed by slug', () => {
      test('resolves a slug of 24 hex characters when no team has that id', async () => {
        const hexName = 'abcdefabcdefabcdefabcdef'
        const created = await server.inject({
          method: 'POST',
          url: '/v1/teams',
          headers: postHeaders('slug-hex'),
          payload: { name: hexName, serviceCode: 'ABC' }
        })
        const bySlug = await server.inject({
          method: 'GET',
          url: `/v1/teams/${hexName}`,
          headers: { 'x-user-id': 'slug-hex' }
        })
        const deployments = await server.inject({
          method: 'GET',
          url: `/v1/teams/${hexName}/deployments`,
          headers: { 'x-user-id': 'slug-hex' }
        })

        expect(created.result.team.slug).toBe(hexName)
        expect(bySlug.statusCode).toBe(200)
        expect(bySlug.result.team._id.toString()).toBe(
          created.result.team._id.toString()
        )
        expect(deployments.statusCode).toBe(200)
      })

      test('gives a team with that id precedence over another team with that slug', async () => {
        const team = await newTeam('slug-id-wins')

        await server.db.collection('teams').insertOne({
          name: `Decoy ${team.teamId}`,
          normalisedName: `decoy-${team.teamId}`,
          slug: team.teamId,
          createdBy: 'slug-decoy',
          idempotencyKey: randomUUID()
        })

        const byId = await server.inject({
          method: 'GET',
          url: `/v1/teams/${team.teamId}`,
          headers: { 'x-user-id': 'slug-id-wins' }
        })

        expect(byId.statusCode).toBe(200)
        expect(byId.result.team._id.toString()).toBe(team.teamId)
      })

      test('reads, changes and removes members the same as by id', async () => {
        const team = await newTeam('slug-1')
        const memberId = await activeMember(team, 'slug-1')
        const bySlug = await server.inject({
          method: 'GET',
          url: `/v1/teams/${team.slug}`,
          headers: { 'x-user-id': memberId }
        })
        const byId = await server.inject({
          method: 'GET',
          url: `/v1/teams/${team.teamId}`,
          headers: { 'x-user-id': memberId }
        })

        expect(bySlug.statusCode).toBe(200)
        expect(bySlug.result.team._id.toString()).toBe(team.teamId)
        expect(bySlug.result.members).toHaveLength(2)
        expect(byId.result.members).toHaveLength(2)

        const memberRecord = bySlug.result.members.find(
          (member) => member.userId === memberId
        )
        const promoted = await server.inject({
          method: 'PATCH',
          url: `/v1/teams/${team.slug}/members/${memberRecord._id}`,
          headers: { 'x-user-id': 'slug-1' },
          payload: { role: 'admin' }
        })
        const removed = await server.inject({
          method: 'DELETE',
          url: `/v1/teams/${team.slug}/members/${memberRecord._id}`,
          headers: { 'x-user-id': 'slug-1' }
        })

        expect(promoted.statusCode).toBe(200)
        expect(promoted.result.member.role).toBe('admin')
        expect(removed.statusCode).toBe(204)
      })

      test('keeps a member who is not an admin from changing or removing members', async () => {
        const team = await newTeam('slug-2')
        const memberId = await activeMember(team, 'slug-2')
        const members = await server.inject({
          method: 'GET',
          url: `/v1/teams/${team.slug}`,
          headers: { 'x-user-id': memberId }
        })
        const adminRecord = members.result.members.find(
          (member) => member.role === 'admin'
        )

        const changed = await server.inject({
          method: 'PATCH',
          url: `/v1/teams/${team.slug}/members/${adminRecord._id}`,
          headers: { 'x-user-id': memberId },
          payload: { role: 'user' }
        })
        const removed = await server.inject({
          method: 'DELETE',
          url: `/v1/teams/${team.slug}/members/${adminRecord._id}`,
          headers: { 'x-user-id': memberId }
        })

        expect(changed.statusCode).toBe(403)
        expect(removed.statusCode).toBe(403)
      })

      test('is not found for someone outside the team, and for an unknown slug', async () => {
        const team = await newTeam('slug-3')

        const stranger = await server.inject({
          method: 'GET',
          url: `/v1/teams/${team.slug}`,
          headers: { 'x-user-id': 'slug-outsider' }
        })
        const strangerRemoves = await server.inject({
          method: 'DELETE',
          url: `/v1/teams/${team.slug}/members/507f1f77bcf86cd799439011`,
          headers: { 'x-user-id': 'slug-outsider' }
        })
        const unknown = await server.inject({
          method: 'GET',
          url: '/v1/teams/no-such-team',
          headers: { 'x-user-id': 'slug-3' }
        })
        const notASlug = await server.inject({
          method: 'GET',
          url: '/v1/teams/Not%20A%20Slug',
          headers: { 'x-user-id': 'slug-3' }
        })

        expect(stranger.statusCode).toBe(404)
        expect(strangerRemoves.statusCode).toBe(404)
        expect(unknown.statusCode).toBe(404)
        expect(notASlug.statusCode).toBe(404)
      })
    })

    describe('GET /v1/teams/{id} environments', () => {
      let config
      let mockTeamFileReader
      let configuredEnvironments

      beforeAll(async () => {
        ;({ config } = await import('#/config.js'))
        ;({ mockTeamFileReader } =
          await import('#/adapters/mock-team-file-reader.js'))
        configuredEnvironments = config.get('teamDeployment.environments')
      })

      afterEach(() => {
        config.set('teamDeployment.environments', configuredEnvironments)
        vi.restoreAllMocks()
      })

      // The tenant files `main` holds, by path.
      function tenantFiles(files) {
        vi.spyOn(mockTeamFileReader, 'getCurrentDocument').mockImplementation(
          async ({ path }) => ({
            document: files[path] ?? null
          })
        )
      }

      function fileWithLimits(limits) {
        return { gateway: { credentialType: 'oauth', limits } }
      }

      function getTeam(team, userId, by = 'slug') {
        return server.inject({
          method: 'GET',
          url: `/v1/teams/${by === 'slug' ? team.slug : team.teamId}`,
          headers: { 'x-user-id': userId }
        })
      }

      test('lists each environment the team has a file in, with its own limits, in environment order', async () => {
        const team = await newTeam('env-1')
        const memberId = await activeMember(team, 'env-1')

        config.set('teamDeployment.environments', [
          'infradev',
          'qa',
          'preprod',
          'prod'
        ])
        tenantFiles({
          [`environments/qa/${team.slug}.json`]: fileWithLimits({
            requestsPerMinute: 120,
            tokensPerMinute: 5000
          }),
          [`environments/infradev/${team.slug}.json`]: fileWithLimits({
            requestsPerMinute: 60,
            tokensPerMinute: 1000
          })
        })

        const asAdmin = await getTeam(team, 'env-1')
        const asMember = await getTeam(team, memberId, 'id')

        const expected = [
          {
            environment: 'infradev',
            limits: { requestsPerMinute: 60, tokensPerMinute: 1000 }
          },
          {
            environment: 'qa',
            limits: { requestsPerMinute: 120, tokensPerMinute: 5000 }
          }
        ]

        expect(asAdmin.statusCode).toBe(200)
        expect(asAdmin.result.environments).toEqual(expected)
        expect(asMember.result.environments).toEqual(expected)
      })

      test('is empty for a team with no file in any environment', async () => {
        const team = await newTeam('env-2')

        const { result } = await getTeam(team, 'env-2')

        expect(result.environments).toEqual([])
      })

      test('is refused as upstream-unavailable when a file cannot be read, not as an empty list', async () => {
        const team = await newTeam('env-4')

        vi.spyOn(mockTeamFileReader, 'getCurrentDocument').mockRejectedValue(
          new Error('GitHub is down')
        )

        const { statusCode, result } = await getTeam(team, 'env-4')

        expect(statusCode).toBe(502)
        expect(result.code).toBe('upstream-unavailable')
      })

      test('does not read the files for someone outside the team', async () => {
        const team = await newTeam('env-3')
        tenantFiles({})

        const { statusCode } = await getTeam(team, 'env-outsider')

        expect(statusCode).toBe(404)
        expect(mockTeamFileReader.getCurrentDocument).not.toHaveBeenCalled()
      })
    })
  })

  describe('POST /v1/teams/{id}/people/search', () => {
    function search(team, actorId, payload, by = 'id') {
      return server.inject({
        method: 'POST',
        url: `/v1/teams/${by === 'slug' ? team.slug : team.teamId}/people/search`,
        headers: { 'x-user-id': actorId },
        payload
      })
    }

    test('finds people by name, in any word order, as oid, displayName and email only', async () => {
      const team = await teamWithAdmin('search-1')

      const { result, statusCode } = await search(team, team.adminId, {
        search: 'hartley amelia'
      })

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        items: [
          {
            oid: SEEDED.amelia,
            displayName: 'Amelia Hartley',
            email: 'amelia.hartley@defra.gov.uk'
          }
        ]
      })
    })

    test('finds a person by the start of their email, by slug', async () => {
      const team = await teamWithAdmin('search-2')

      const { result } = await search(
        team,
        team.adminId,
        { search: 'journey.test.me' },
        'slug'
      )

      expect(result.items.map((item) => item.oid)).toEqual([SEEDED.journey])
    })

    test('shows the user principal name when the person has no mail', async () => {
      const team = await teamWithAdmin('search-3')

      const { result } = await search(team, team.adminId, { search: 'farid' })

      expect(result.items).toEqual([
        {
          oid: SEEDED.farid,
          displayName: 'Farid Haidari',
          email: 'farid.haidari@defra.onmicrosoft.com'
        }
      ])
    })

    test('leaves out suppliers, guests and look-alike domains', async () => {
      const team = await teamWithAdmin('search-4')

      for (const text of ['sasha', 'gavin', 'lola']) {
        const { result, statusCode } = await search(team, team.adminId, {
          search: text
        })

        expect(statusCode).toBe(200)
        expect(result.items).toEqual([])
      }
    })

    test('leaves out people who are already active members, but not removed ones', async () => {
      const team = await teamWithAdmin('search-5')
      const added = await addSeeded(team, 'cerys')
      const other = await addSeeded(team, 'daniel')

      await server.inject({
        method: 'DELETE',
        url: `/v1/teams/${team.teamId}/members/${other._id}`,
        headers: { 'x-user-id': team.adminId }
      })
      const { result } = await search(team, team.adminId, { search: 'cerys' })
      const daniel = await search(team, team.adminId, { search: 'daniel' })

      expect(added.userId).toEqual(expect.any(String))
      expect(result.items).toEqual([])
      expect(daniel.result.items.map((item) => item.oid)).toEqual([
        SEEDED.daniel
      ])
    })

    test('sorts by name and returns at most 20', async () => {
      const team = await teamWithAdmin('search-6')
      const { mockDirectory } = await import('#/adapters/mock-directory.js')
      const crowd = Array.from({ length: 30 }, (_, index) => ({
        oid: randomUUID(),
        displayName: `Zed Person ${String(30 - index).padStart(2, '0')}`,
        mail: `zed.person.${index}@defra.gov.uk`,
        userPrincipalName: `zed.person.${index}@defra.gov.uk`
      }))

      vi.spyOn(mockDirectory, 'searchPeople').mockResolvedValue(crowd)
      const { result } = await search(team, team.adminId, { search: 'zed' })

      vi.restoreAllMocks()

      expect(result.items).toHaveLength(20)
      expect(result.items.map((item) => item.displayName)).toEqual(
        Array.from(
          { length: 20 },
          (_, index) => `Zed Person ${String(index + 1).padStart(2, '0')}`
        )
      )
    })

    test.each([
      ['one character', { search: 'a' }],
      ['one character once trimmed', { search: ' a ' }],
      ['101 characters', { search: 'a'.repeat(101) }],
      ['no search', {}],
      ['an unknown key', { search: 'amelia', limit: 5 }],
      ['text that is not a string', { search: 42 }]
    ])('refuses %s', async (_, payload) => {
      const team = await teamWithAdmin('search-7')

      const { statusCode } = await search(team, team.adminId, payload)

      expect(statusCode).toBe(400)
    })

    test.each([
      ['one character', 'g', '"g"'],
      ['101 characters', 'q'.repeat(101), 'qqqqqqqqqq']
    ])(
      'never writes the search text of a %s to the log (F1)',
      async (_, text, probe) => {
        const team = await teamWithAdmin('search-log')
        const { createLogger } =
          await import('#/common/helpers/logging/logger.js')
        const warn = vi
          .spyOn(createLogger(), 'warn')
          .mockImplementation(() => {})

        const { statusCode } = await search(team, team.adminId, {
          search: text
        })
        const logged = JSON.stringify(warn.mock.calls)

        vi.restoreAllMocks()

        expect(statusCode).toBe(400)
        expect(logged).toContain('Request validation failed')
        expect(logged).not.toContain(probe)
        expect(logged).not.toContain('_original')
      }
    )

    test('accepts 2 and 100 characters', async () => {
      const team = await teamWithAdmin('search-8')

      const short = await search(team, team.adminId, { search: 'am' })
      const long = await search(team, team.adminId, { search: 'a'.repeat(100) })

      expect(short.statusCode).toBe(200)
      expect(long.statusCode).toBe(200)
    })

    test('refuses a request with no x-user-id', async () => {
      const team = await teamWithAdmin('search-9')

      const { statusCode } = await server.inject({
        method: 'POST',
        url: `/v1/teams/${team.teamId}/people/search`,
        payload: { search: 'amelia' }
      })

      expect(statusCode).toBe(400)
    })

    test('refuses a member who is not an admin', async () => {
      const team = await teamWithAdmin('search-10')
      const member = await addSeeded(team, 'bashir')

      const { result, statusCode } = await search(team, member.userId, {
        search: 'amelia'
      })

      expect(statusCode).toBe(403)
      expect(result.code).toBe('admin-required')
    })

    test('is not found for someone outside the team, and for an unknown team', async () => {
      const team = await teamWithAdmin('search-11')
      const outsider = await signInAs('search-outsider')

      const stranger = await search(team, outsider, { search: 'amelia' })
      const unknown = await search(
        { slug: 'no-such-team' },
        team.adminId,
        { search: 'amelia' },
        'slug'
      )

      expect(stranger.statusCode).toBe(404)
      expect(unknown.statusCode).toBe(404)
    })

    test('gives 503 directory-unavailable when the directory fails', async () => {
      const team = await teamWithAdmin('search-12')
      const { mockDirectory } = await import('#/adapters/mock-directory.js')
      const { boomWithCode, Boom } =
        await import('#/common/helpers/boom-with-code.js')

      vi.spyOn(mockDirectory, 'searchPeople').mockRejectedValue(
        boomWithCode(
          Boom.serverUnavailable,
          'The directory is unavailable',
          'directory-unavailable'
        )
      )
      const { result, statusCode } = await search(team, team.adminId, {
        search: 'amelia'
      })

      vi.restoreAllMocks()

      expect(statusCode).toBe(503)
      expect(result.code).toBe('directory-unavailable')
    })

    test('does not call the directory for someone who may not search', async () => {
      const team = await teamWithAdmin('search-13')
      const member = await addSeeded(team, 'eleanor')
      const { mockDirectory } = await import('#/adapters/mock-directory.js')
      const searchPeople = vi.spyOn(mockDirectory, 'searchPeople')

      await search(team, member.userId, { search: 'amelia' })

      expect(searchPeople).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })

    test('records nothing about the search in the audit trail', async () => {
      const team = await teamWithAdmin('search-14')
      const before = await server.db.collection('auditEvents').countDocuments()

      await search(team, team.adminId, { search: 'distinctive-search-text' })

      const events = await server.db.collection('auditEvents').find().toArray()

      expect(events).toHaveLength(before)
      expect(JSON.stringify(events)).not.toContain('distinctive-search-text')
    })
  })
})
