import { randomUUID } from 'node:crypto'

const ENTRA_TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'

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
    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: postHeaders('team-patch-admin-2'),
      payload: { name: 'Service Code Guard Team', serviceCode: 'ABC' }
    })
    const teamId = created.result.team._id.toString()

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/members`,
      headers: postHeaders('team-patch-admin-2'),
      payload: { email: 'service.code.member@defra.gov.uk' }
    })
    const member = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: randomUUID(),
        tid: ENTRA_TENANT_ID,
        email: 'service.code.member@defra.gov.uk',
        displayName: 'Service Code Member'
      }
    })

    const { statusCode } = await server.inject({
      method: 'PATCH',
      url: `/v1/teams/${teamId}`,
      headers: { 'x-user-id': member.result.user._id.toString() },
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

  test('POST /v1/teams/{id}/members creates one membership when the same email is invited concurrently', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: postHeaders('team-user-2c'),
      payload: { name: 'Concurrent Invite Team', serviceCode: 'ABC' }
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

  test('GET /v1/teams returns role: user for an invited active member', async () => {
    const headers = {
      'x-user-id': 'team-user-4b',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 4b', serviceCode: 'ABC' }
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
        oid: randomUUID(),
        tid: ENTRA_TENANT_ID,
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

  test('POST /v1/teams/{id}/members invites a member with the user role', async () => {
    const headers = {
      'x-user-id': 'team-user-7',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 7', serviceCode: 'ABC' }
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
      payload: { name: 'My Team 7b', serviceCode: 'ABC' }
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
      payload: { name: 'My Team 8', serviceCode: 'ABC' }
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
        oid: randomUUID(),
        tid: ENTRA_TENANT_ID,
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
      payload: { name: 'My Team 9', serviceCode: 'ABC' }
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
      payload: { name: 'My Team 10', serviceCode: 'ABC' }
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
        oid: randomUUID(),
        tid: ENTRA_TENANT_ID,
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

  test('GET /v1/teams/{id} includes a member\u2019s display name once they have signed in', async () => {
    const headers = {
      'x-user-id': 'team-user-11',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 11', serviceCode: 'ABC' }
    })

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${created.result.team._id}/members`,
      headers: postHeaders('team-user-11'),
      payload: { email: 'named.member@defra.gov.uk' }
    })

    await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: randomUUID(),
        tid: ENTRA_TENANT_ID,
        email: 'named.member@defra.gov.uk',
        displayName: 'Named Member'
      }
    })

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${created.result.team._id}`,
      headers: { 'x-user-id': 'team-user-11' }
    })

    const named = result.members.find(
      (member) => member.email === 'named.member@defra.gov.uk'
    )

    expect(named.displayName).toBe('Named Member')
  })

  test('GET /v1/teams/{id} returns a null display name for a member who has not signed in yet', async () => {
    const headers = {
      'x-user-id': 'team-user-11b',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 11b', serviceCode: 'ABC' }
    })

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${created.result.team._id}/members`,
      headers: postHeaders('team-user-11b'),
      payload: { email: 'not.signed.in@defra.gov.uk' }
    })

    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/teams/${created.result.team._id}`,
      headers: { 'x-user-id': 'team-user-11b' }
    })

    const invited = result.members.find(
      (member) => member.email === 'not.signed.in@defra.gov.uk'
    )

    expect(invited.displayName).toBeNull()
  })

  test('DELETE /v1/teams/{id}/members/{memberId} lets an admin remove a member', async () => {
    const headers = {
      'x-user-id': 'team-user-12',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 12', serviceCode: 'ABC' }
    })
    const teamId = created.result.team._id.toString()

    const invited = await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/members`,
      headers: postHeaders('team-user-12'),
      payload: { email: 'removable@defra.gov.uk' }
    })

    const { statusCode } = await server.inject({
      method: 'DELETE',
      url: `/v1/teams/${teamId}/members/${invited.result.member._id}`,
      headers: { 'x-user-id': 'team-user-12' }
    })

    expect(statusCode).toBe(204)

    const team = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}`,
      headers: { 'x-user-id': 'team-user-12' }
    })
    const removed = team.result.members.find(
      (member) => member.email === 'removable@defra.gov.uk'
    )

    expect(removed.status).toBe('removed')
  })

  test('DELETE /v1/teams/{id}/members/{memberId} rejects a non-admin', async () => {
    const headers = {
      'x-user-id': 'team-user-13',
      'idempotency-key': randomUUID()
    }

    const created = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers,
      payload: { name: 'My Team 13', serviceCode: 'ABC' }
    })
    const teamId = created.result.team._id.toString()

    await server.inject({
      method: 'POST',
      url: `/v1/teams/${teamId}/members`,
      headers: postHeaders('team-user-13'),
      payload: { email: 'non-admin-actor@defra.gov.uk' }
    })
    await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: randomUUID(),
        tid: ENTRA_TENANT_ID,
        email: 'non-admin-actor@defra.gov.uk',
        displayName: 'Non Admin Actor'
      }
    })

    const team = await server.inject({
      method: 'GET',
      url: `/v1/teams/${teamId}`,
      headers: { 'x-user-id': 'team-user-13' }
    })
    const nonAdminMember = team.result.members.find(
      (member) => member.email === 'non-admin-actor@defra.gov.uk'
    )

    const { result, statusCode } = await server.inject({
      method: 'DELETE',
      url: `/v1/teams/${teamId}/members/${nonAdminMember._id}`,
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
      const email = `${label}@defra.gov.uk`
      const created = await server.inject({
        method: 'POST',
        url: '/v1/teams',
        headers: postHeaders(label),
        payload: { name: `Role Team ${label}`, serviceCode: 'ABC' }
      })
      const teamId = created.result.team._id.toString()

      await server.inject({
        method: 'POST',
        url: `/v1/teams/${teamId}/members`,
        headers: postHeaders(label),
        payload: { email }
      })
      const signedIn = await server.inject({
        method: 'POST',
        url: '/v1/users',
        payload: {
          oid: randomUUID(),
          tid: ENTRA_TENANT_ID,
          email,
          displayName: 'Role Member'
        }
      })

      const team = await server.inject({
        method: 'GET',
        url: `/v1/teams/${teamId}`,
        headers: { 'x-user-id': label }
      })

      return {
        teamId,
        admin: team.result.members.find((member) => member.role === 'admin'),
        member: team.result.members.find((member) => member.email === email),
        memberUserId: signedIn.result.user._id.toString()
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
})
