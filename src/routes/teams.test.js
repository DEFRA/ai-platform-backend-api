import { randomUUID } from 'node:crypto'

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

  test('POST /v1/teams creates a team and makes the creator an admin', async () => {
    const { result, statusCode, headers } = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: {
        'x-user-id': 'team-user-1',
        'idempotency-key': randomUUID()
      },
      payload: { name: 'Flood Risk Team' }
    })

    expect(statusCode).toBe(201)
    expect(headers.location).toBe(`/v1/teams/${result.team._id}`)
    expect(result.team.normalisedName).toBe('flood-risk-team')
    expect(result.team.verified).toBe(false)
  })

  test('POST /v1/teams replays without creating a duplicate for a repeated Idempotency-Key', async () => {
    const idempotencyKey = randomUUID()
    const headers = {
      'x-user-id': 'team-user-2',
      'idempotency-key': idempotencyKey
    }
    const payload = { name: 'Replay Team' }

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
          payload: { name: 'Concurrent Replay Team' }
        })
      )
    )

    const ids = new Set(
      responses.map((response) => response.result.team._id.toString())
    )

    expect(ids.size).toBe(1)
    expect(responses.every((response) => response.statusCode < 400)).toBe(true)
  })

  test('POST /v1/teams/{id}/members creates one membership when the same email is invited concurrently', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: postHeaders('team-user-2c'),
      payload: { name: 'Concurrent Invite Team' }
    })
    const teamId = created.result.team._id.toString()

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        server.inject({
          method: 'POST',
          url: `/v1/teams/${teamId}/members`,
          headers: postHeaders('team-user-2c'),
          payload: { email: 'concurrent.invite@defra.gov.uk' }
        })
      )
    )

    expect(
      responses.filter((response) => response.statusCode === 201)
    ).toHaveLength(1)

    const team = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}`,
      headers: { 'x-user-id': 'team-user-2c' }
    })

    expect(
      team.result.members.filter(
        (member) => member.email === 'concurrent.invite@defra.gov.uk'
      )
    ).toHaveLength(1)
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
      payload: { name: 'Unique Team' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { name: 'Unique Team' }
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
      payload: { name: 'My Team 4' }
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

  test('GET /v1/teams returns role: user for an invited active member', async () => {
    const headers = {
      'x-user-id': 'team-user-4b',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 4b' }
    })
    const teamId = created.result.team._id.toString()

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/members`,
      headers,
      payload: { email: 'list-role-teammate@defra.gov.uk' }
    })
    const signIn = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        email: 'list-role-teammate@defra.gov.uk',
        displayName: 'List Role Teammate'
      }
    })

    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: '/v1/teams',
      headers: { 'x-user-id': signIn.result.user._id.toString() }
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
      payload: { name: 'My Team 5' }
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
      payload: { name: 'My Team 6' }
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

  test('POST /v1/teams/{id}/members invites a member with the user role', async () => {
    const headers = {
      'x-user-id': 'team-user-7',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 7' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${created.result.team._id}/members`,
      headers: postHeaders('team-user-7'),
      payload: { email: 'invitee@defra.gov.uk' }
    })

    expect(statusCode).toBe(201)
    expect(result.member.status).toBe('invited')
    expect(result.member.role).toBe('user')
  })

  test('POST /v1/teams/{id}/members rejects a duplicate invite for the same email', async () => {
    const headers = {
      'x-user-id': 'team-user-7b',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 7b' }
    })

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${created.result.team._id}/members`,
      headers: postHeaders('team-user-7b'),
      payload: { email: 'duplicate@defra.gov.uk' }
    })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${created.result.team._id}/members`,
      headers: postHeaders('team-user-7b'),
      payload: { email: 'duplicate@defra.gov.uk' }
    })

    expect(statusCode).toBe(409)
    expect(result.code).toBe('member-exists')
  })

  test('POST /v1/teams/{id}/members rejects a non-admin member', async () => {
    const headers = {
      'x-user-id': 'team-user-8',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 8' }
    })

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${created.result.team._id}/members`,
      headers: postHeaders('team-user-8'),
      payload: { email: 'user-member@defra.gov.uk' }
    })

    // binds the invited member so they become an active, non-admin member
    await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        email: 'user-member@defra.gov.uk',
        displayName: 'User Member'
      }
    })

    const team = await server.inject({
      method: 'GET',
      url: `/v1/teams/${created.result.team._id}`,
      headers: { 'x-user-id': 'team-user-8' }
    })

    const boundMember = team.result.members.find(
      (member) => member.email === 'user-member@defra.gov.uk'
    )

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${created.result.team._id}/members`,
      headers: postHeaders(boundMember.userId),
      payload: { email: 'another@defra.gov.uk' }
    })

    expect(statusCode).toBe(403)
    expect(result.code).toBe('admin-required')
  })

  test('POST /v1/teams/{id}/members returns 404 for a non-member actor', async () => {
    const headers = {
      'x-user-id': 'team-user-9',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 9' }
    })

    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${created.result.team._id}/members`,
      headers: postHeaders('someone-else'),
      payload: { email: 'invitee2@defra.gov.uk' }
    })

    expect(statusCode).toBe(404)
  })

  test('POST /v1/users binds an invited member to the signed-in user on first sign-in', async () => {
    const headers = {
      'x-user-id': 'team-user-10',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 10' }
    })

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${created.result.team._id}/members`,
      headers: postHeaders('team-user-10'),
      payload: { email: 'bound.member@defra.gov.uk' }
    })

    await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        email: 'bound.member@defra.gov.uk',
        displayName: 'Bound Member'
      }
    })

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${created.result.team._id}`,
      headers: { 'x-user-id': 'team-user-10' }
    })

    const bound = result.members.find(
      (member) => member.email === 'bound.member@defra.gov.uk'
    )

    expect(bound.status).toBe('active')
    expect(bound.userId).not.toBeNull()
  })
})
