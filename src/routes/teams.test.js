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

    // Invites the email, then signs them in so they are an active member;
    // returns their user id, which is their x-user-id.
    async function activeMember(team, adminLabel, email, role) {
      await server.inject({
        method: 'POST',
        url: `/v1/teams/${team.teamId}/members`,
        headers: postHeaders(adminLabel),
        payload: role ? { email, role } : { email }
      })
      const signedIn = await server.inject({
        method: 'POST',
        url: '/v1/users',
        payload: {
          oid: randomUUID(),
          tid: ENTRA_TENANT_ID,
          email,
          displayName: 'Details Member'
        }
      })

      return signedIn.result.user._id.toString()
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
        const memberId = await activeMember(
          team,
          'details-5',
          'details.five.member@defra.gov.uk'
        )

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
      function invite(team, userId, payload, by = 'id') {
        return server.inject({
          method: 'POST',
          url: `/v1/teams/${by === 'slug' ? team.slug : team.teamId}/members`,
          headers: postHeaders(userId),
          payload
        })
      }

      test('defaults to user', async () => {
        const team = await newTeam('role-default')

        const { result, statusCode } = await invite(team, 'role-default', {
          email: 'role.default@defra.gov.uk'
        })

        expect(statusCode).toBe(201)
        expect(result.member.role).toBe('user')
      })

      test.each([['admin'], ['user']])(
        'lets an admin invite someone as %s, by slug',
        async (role) => {
          const label = `role-${role}`
          const team = await newTeam(label)

          const { result, statusCode, headers } = await invite(
            team,
            label,
            { email: `role.${role}@defra.gov.uk`, role },
            'slug'
          )

          expect(statusCode).toBe(201)
          expect(result.member.role).toBe(role)
          expect(headers.location).toBe(`/v1/teams/${team.slug}/members`)
        }
      )

      test('makes an invited admin an active admin once they sign in', async () => {
        const team = await newTeam('role-signin')
        const adminId = await activeMember(
          team,
          'role-signin',
          'role.signin@defra.gov.uk',
          'admin'
        )

        const { statusCode } = await patch(team, adminId, {
          description: 'Set by the invited admin'
        })

        expect(statusCode).toBe(200)
      })

      test.each([
        ['a role it does not know', { role: 'owner' }],
        ['an unknown key', { role: 'user', name: 'Someone' }]
      ])('refuses %s', async (_, extra) => {
        const team = await newTeam('role-bad')

        const { statusCode } = await invite(team, 'role-bad', {
          email: 'role.bad@defra.gov.uk',
          ...extra
        })

        expect(statusCode).toBe(400)
      })

      test('refuses a member who is not an admin, even to add a user', async () => {
        const team = await newTeam('role-member')
        const memberId = await activeMember(
          team,
          'role-member',
          'role.member@defra.gov.uk'
        )

        const asAdmin = await invite(
          team,
          memberId,
          { email: 'role.sneaky@defra.gov.uk', role: 'admin' },
          'slug'
        )
        const asUser = await invite(team, memberId, {
          email: 'role.sneaky2@defra.gov.uk'
        })

        expect(asAdmin.statusCode).toBe(403)
        expect(asAdmin.result.code).toBe('admin-required')
        expect(asUser.statusCode).toBe(403)
      })

      test('is not found for someone outside the team, and for an unknown slug', async () => {
        const team = await newTeam('role-stranger')

        const stranger = await invite(
          team,
          'role-outsider',
          { email: 'role.outsider@defra.gov.uk', role: 'admin' },
          'slug'
        )
        const unknown = await invite(
          { slug: 'no-such-team' },
          'role-stranger',
          { email: 'role.nobody@defra.gov.uk' },
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
        const memberId = await activeMember(
          team,
          'slug-1',
          'slug.one.member@defra.gov.uk'
        )
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
        const memberId = await activeMember(
          team,
          'slug-2',
          'slug.two.member@defra.gov.uk'
        )
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
      let mockTenantOrchestrator
      let configuredEnvironments

      beforeAll(async () => {
        ;({ config } = await import('#/config.js'))
        ;({ mockTenantOrchestrator } =
          await import('#/adapters/mock-tenant-orchestrator.js'))
        configuredEnvironments = config.get('teamDeployment.environments')
      })

      afterEach(() => {
        config.set('teamDeployment.environments', configuredEnvironments)
        vi.restoreAllMocks()
      })

      // The tenant files `main` holds, by path.
      function tenantFiles(files) {
        vi.spyOn(
          mockTenantOrchestrator,
          'getCurrentDocument'
        ).mockImplementation(async ({ path }) => ({
          document: files[path] ?? null
        }))
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
        const memberId = await activeMember(
          team,
          'env-1',
          'env.one.member@defra.gov.uk'
        )

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

        vi.spyOn(
          mockTenantOrchestrator,
          'getCurrentDocument'
        ).mockRejectedValue(new Error('GitHub is down'))

        const { statusCode, result } = await getTeam(team, 'env-4')

        expect(statusCode).toBe(502)
        expect(result.code).toBe('upstream-unavailable')
      })

      test('does not read the files for someone outside the team', async () => {
        const team = await newTeam('env-3')
        tenantFiles({})

        const { statusCode } = await getTeam(team, 'env-outsider')

        expect(statusCode).toBe(404)
        expect(mockTenantOrchestrator.getCurrentDocument).not.toHaveBeenCalled()
      })
    })
  })
})
