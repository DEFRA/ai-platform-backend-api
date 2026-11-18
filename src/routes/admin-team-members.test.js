import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

import {
  authFor,
  appAuth,
  oidFor,
  withTestUsers
} from '#/common/test-helpers/portal-token.js'

const ADMIN_ROLES = ['research-user', 'platform-admin']
const ADMIN = 'admin-members-admin'

// People the mock directory holds (src/adapters/fixtures/directory-people.json).
const SEEDED = {
  journey: '5eed0000-0000-4000-8000-000000000001',
  amelia: '5eed0000-0000-4000-8000-000000000002',
  bashir: '5eed0000-0000-4000-8000-000000000003',
  cerys: '5eed0000-0000-4000-8000-000000000004',
  daniel: '5eed0000-0000-4000-8000-000000000005',
  eleanor: '5eed0000-0000-4000-8000-000000000006',
  supplier: '5eed0000-0000-4000-8000-000000000009'
}

describe('#admin team members', () => {
  let server
  let createLogger

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    withTestUsers(server)
    ;({ createLogger } = await import('#/common/helpers/logging/logger.js'))
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const asAdmin = (label = ADMIN) => authFor(label, { roles: ADMIN_ROLES })

  function call({ method, url, headers = asAdmin(), payload, key }) {
    return server.inject({
      method,
      url,
      headers: { ...headers, ...(key && { 'idempotency-key': key }) },
      payload
    })
  }

  // A team whose members are written straight to the database, so the
  // platform admin who acts on it is plainly not one of them.
  async function seedTeam({ status, admins = 1, users = 0 } = {}) {
    const label = randomUUID().slice(0, 8)
    const { insertedId } = await server.db.collection('teams').insertOne({
      name: `Admin members ${label}`,
      normalisedName: `admin-members-${label}`,
      slug: `am-${label}`,
      serviceCode: 'ABC',
      createdBy: 'seed',
      ...(status && { status })
    })
    const teamId = insertedId.toString()
    const roles = [...Array(admins).fill('admin'), ...Array(users).fill('user')]
    const members = []

    for (const role of roles) {
      const { insertedId: userId } = await server.db
        .collection('users')
        .insertOne({
          oid: randomUUID(),
          tid: '6f504113-6b64-43f2-ade9-242e05780007',
          email: `${randomUUID()}@defra.gov.uk`,
          displayName: `Member ${role}`,
          roles: ['research-user']
        })
      const { insertedId: memberId } = await server.db
        .collection('teamMembers')
        .insertOne({
          teamId,
          userId: userId.toString(),
          role,
          status: 'active'
        })

      members.push({
        memberId: memberId.toString(),
        userId: userId.toString(),
        role
      })
    }

    return { teamId, slug: `am-${label}`, members }
  }

  const addTo = (team, payload, options = {}) =>
    call({
      method: 'POST',
      url: `/v1/admin/teams/${options.by === 'slug' ? team.slug : team.teamId}/members`,
      payload: { role: 'user', ...payload },
      key: randomUUID(),
      ...options
    })

  const removeFrom = (team, memberId, options = {}) =>
    call({
      method: 'DELETE',
      url: `/v1/admin/teams/${team.teamId}/members/${memberId}`,
      ...options
    })

  const searchIn = (team, search, options = {}) =>
    call({
      method: 'POST',
      url: `/v1/admin/teams/${team.teamId}/people/search`,
      payload: { search },
      ...options
    })

  function events(teamId, action) {
    return server.db
      .collection('auditEvents')
      .find({ resourceId: teamId, action })
      .toArray()
  }

  function activeMembers(teamId) {
    return server.db
      .collection('teamMembers')
      .countDocuments({ teamId, status: 'active' })
  }

  describe('POST /v1/admin/teams/{id}/members', () => {
    test('adds a person by object ID with the role asked for, shows at once, and audits it as a Platform Admin', async () => {
      const team = await seedTeam()

      const { statusCode, result, headers } = await addTo(
        team,
        { oid: SEEDED.amelia, role: 'admin' },
        { by: 'slug' }
      )

      expect(statusCode).toBe(201)
      expect(headers.location).toBe(`/v1/admin/teams/${team.slug}`)
      expect(result.member).toMatchObject({
        teamId: team.teamId,
        role: 'admin',
        status: 'active',
        displayName: expect.any(String)
      })
      expect(await activeMembers(team.teamId)).toBe(2)

      const [event] = await events(team.teamId, 'team.addMember')

      expect(event).toMatchObject({
        actorUserId: ADMIN,
        oid: oidFor(ADMIN),
        role: 'platform-admin',
        outcome: 'success',
        code: 'admin',
        subjectOid: SEEDED.amelia,
        teamId: team.teamId
      })
      expect(JSON.stringify(event)).not.toMatch(/@defra|Bearer|eyJ/)
    })

    test.each([['disabled'], ['pending-removal']])(
      'adds to a %s team',
      async (status) => {
        const team = await seedTeam({ status })

        const { statusCode } = await addTo(team, { oid: SEEDED.bashir })

        expect(statusCode).toBe(201)
      }
    )

    test('refuses a person who is already a member with 409 member-exists, and adds nobody', async () => {
      const team = await seedTeam()

      await addTo(team, { oid: SEEDED.cerys })

      const { statusCode, result } = await addTo(team, { oid: SEEDED.cerys })

      expect(statusCode).toBe(409)
      expect(result.code).toBe('member-exists')
      expect(await activeMembers(team.teamId)).toBe(2)
    })

    test('replays the same Idempotency-Key as the same membership, and refuses it for another person or role', async () => {
      const team = await seedTeam()
      const key = randomUUID()
      const post = (payload) =>
        call({
          method: 'POST',
          url: `/v1/admin/teams/${team.teamId}/members`,
          payload,
          key
        })

      const first = await post({ oid: SEEDED.daniel, role: 'user' })
      const retry = await post({ oid: SEEDED.daniel, role: 'user' })
      const otherPerson = await post({ oid: SEEDED.eleanor, role: 'user' })
      const otherRole = await post({ oid: SEEDED.daniel, role: 'admin' })

      expect(first.statusCode).toBe(201)
      expect(retry.statusCode).toBe(201)
      expect(retry.result.member._id).toEqual(first.result.member._id)
      expect(otherPerson.statusCode).toBe(409)
      expect(otherPerson.result.code).toBe('idempotency-key-reused')
      expect(otherRole.statusCode).toBe(409)
      expect(otherRole.result.code).toBe('idempotency-key-reused')
      expect(await events(team.teamId, 'team.addMember')).toHaveLength(1)
    })

    test('refuses a person the directory does not hold or who is not eligible with 422 person-not-eligible', async () => {
      const team = await seedTeam()

      const unknown = await addTo(team, { oid: randomUUID() })
      const supplier = await addTo(team, { oid: SEEDED.supplier })

      expect(unknown.statusCode).toBe(422)
      expect(unknown.result.code).toBe('person-not-eligible')
      expect(supplier.statusCode).toBe(422)
      expect(await activeMembers(team.teamId)).toBe(1)
    })

    test('refuses a Platform Admin adding themselves with 403 self-add-refused, an access.denied event, and writes nothing', async () => {
      const team = await seedTeam()
      const own = oidFor('admin-members-self')

      const { statusCode, result } = await addTo(
        team,
        { oid: own },
        { headers: asAdmin('admin-members-self') }
      )

      expect(statusCode).toBe(403)
      expect(result.code).toBe('self-add-refused')
      expect(await activeMembers(team.teamId)).toBe(1)

      const [denied] = await events(team.teamId, 'access.denied')

      expect(denied).toMatchObject({
        code: 'self-add-refused',
        role: 'platform-admin',
        outcome: 'failure',
        actorUserId: 'admin-members-self'
      })
    })

    test('refuses the same object ID in upper case as a self-add too', async () => {
      const team = await seedTeam()

      const { statusCode } = await addTo(
        team,
        { oid: oidFor('admin-members-upper').toUpperCase() },
        { headers: asAdmin('admin-members-upper') }
      )

      expect(statusCode).toBe(403)
      expect(await activeMembers(team.teamId)).toBe(1)
    })

    test('refuses a person who is not a Platform Admin, even a team Admin of that team, with 403 and an access.denied event', async () => {
      const team = await seedTeam()
      const [{ userId }] = team.members

      const { statusCode, result } = await addTo(
        team,
        { oid: SEEDED.journey },
        { headers: authFor(userId) }
      )

      expect(statusCode).toBe(403)
      expect(result.code).toBe('platform-admin-required')
      expect(await activeMembers(team.teamId)).toBe(1)
      expect(await events(team.teamId, 'access.denied')).toHaveLength(1)
    })

    test('answers 404 team-not-found for a team nobody has', async () => {
      const { statusCode, result } = await call({
        method: 'POST',
        url: '/v1/admin/teams/no-such-team/members',
        payload: { oid: SEEDED.journey, role: 'user' },
        key: randomUUID()
      })

      expect(statusCode).toBe(404)
      expect(result.code).toBe('team-not-found')
    })

    test.each([
      ['no Idempotency-Key', { oid: SEEDED.journey, role: 'user' }, null],
      ['no role', { oid: SEEDED.journey }, randomUUID()],
      [
        'a role that is not one',
        { oid: SEEDED.journey, role: 'owner' },
        randomUUID()
      ],
      [
        'an oid that is not a GUID',
        { oid: 'amelia', role: 'user' },
        randomUUID()
      ],
      [
        'a key nobody asked for',
        { oid: SEEDED.journey, role: 'user', email: 'a@defra.gov.uk' },
        randomUUID()
      ]
    ])('refuses %s with 400 and adds nobody', async (_name, payload, key) => {
      const team = await seedTeam()

      const { statusCode } = await call({
        method: 'POST',
        url: `/v1/admin/teams/${team.teamId}/members`,
        payload,
        ...(key && { key })
      })

      expect(statusCode).toBe(400)
      expect(await activeMembers(team.teamId)).toBe(1)
    })

    test('refuses the frontend’s own app-only token', async () => {
      const team = await seedTeam()

      const { statusCode } = await addTo(
        team,
        { oid: SEEDED.journey },
        { headers: appAuth() }
      )

      expect(statusCode).toBe(401)
    })
  })

  describe('POST /v1/admin/teams/{id}/people/search', () => {
    test('finds eligible people, leaving out current members, whether or not the admin belongs to the team', async () => {
      const team = await seedTeam()

      await addTo(team, { oid: SEEDED.amelia })

      const { statusCode, result } = await searchIn(team, 'Amelia')
      const found = (await searchIn(team, 'Bashir')).result.items

      expect(statusCode).toBe(200)
      expect(result.items.map(({ oid }) => oid)).not.toContain(SEEDED.amelia)
      expect(found.map(({ oid }) => oid)).toContain(SEEDED.bashir)
      expect(found[0]).toEqual({
        oid: expect.any(String),
        displayName: expect.any(String),
        email: expect.any(String)
      })
    })

    test('searches in a disabled team', async () => {
      const team = await seedTeam({ status: 'disabled' })

      const { statusCode } = await searchIn(team, 'Bashir')

      expect(statusCode).toBe(200)
    })

    test('never logs or stores the search text, a refused one included', async () => {
      const team = await seedTeam()
      const loggers = createLogger()
      const spies = ['info', 'warn', 'error', 'debug'].map((level) =>
        vi.spyOn(loggers, level).mockImplementation(() => {})
      )

      await searchIn(team, 'Unmistakable Search Text')
      await searchIn(team, 'x')
      await searchIn(team, 'q'.repeat(101))

      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls))

      expect(logged).not.toContain('Unmistakable')
      expect(logged).not.toContain('qqqq')
      expect(
        JSON.stringify(
          await server.db
            .collection('auditEvents')
            .find({ resourceId: team.teamId })
            .toArray()
        )
      ).not.toContain('Unmistakable')
    })

    test.each([
      ['a search of one character', { search: 'a' }],
      ['no search', {}],
      ['a key nobody asked for', { search: 'Amelia', limit: 5 }]
    ])('refuses %s with 400', async (_name, payload) => {
      const team = await seedTeam()

      const { statusCode } = await call({
        method: 'POST',
        url: `/v1/admin/teams/${team.teamId}/people/search`,
        payload
      })

      expect(statusCode).toBe(400)
    })

    test('refuses a person who is not a Platform Admin with 403 and an access.denied event, before searching the directory', async () => {
      const team = await seedTeam()
      const { getDirectory } = await import('#/adapters/directory-registry.js')
      const search = vi.spyOn(getDirectory(), 'searchPeople')

      const { statusCode, result } = await searchIn(team, 'Amelia', {
        headers: authFor('admin-members-plain')
      })

      expect(statusCode).toBe(403)
      expect(result.code).toBe('platform-admin-required')
      expect(search).not.toHaveBeenCalled()
      expect(await events(team.teamId, 'access.denied')).toHaveLength(1)
    })

    test('answers 404 team-not-found for a team nobody has', async () => {
      const { statusCode, result } = await call({
        method: 'POST',
        url: '/v1/admin/teams/no-such-team/people/search',
        payload: { search: 'Amelia' }
      })

      expect(statusCode).toBe(404)
      expect(result.code).toBe('team-not-found')
    })
  })

  describe('DELETE /v1/admin/teams/{id}/members/{memberId}', () => {
    test('removes a member, answers 204, and audits it as a Platform Admin with the person removed', async () => {
      const team = await seedTeam({ admins: 2, users: 1 })
      const user = team.members.find(({ role }) => role === 'user')

      const { statusCode } = await removeFrom(team, user.memberId)

      expect(statusCode).toBe(204)
      expect(await activeMembers(team.teamId)).toBe(2)

      const stored = await server.db
        .collection('teamMembers')
        .findOne({ _id: new ObjectId(user.memberId) })
      const [event] = await events(team.teamId, 'team.removeMember')

      expect(stored).toMatchObject({ status: 'removed', removedBy: ADMIN })
      expect(event).toMatchObject({
        actorUserId: ADMIN,
        role: 'platform-admin',
        outcome: 'success',
        teamId: team.teamId,
        subjectOid: expect.any(String)
      })
    })

    test('removes a member whose person record cannot be found, and records the removal without a subjectOid', async () => {
      const team = await seedTeam({ admins: 1 })
      const { insertedId } = await server.db
        .collection('teamMembers')
        .insertOne({
          teamId: team.teamId,
          userId: 'legacy-not-an-object-id',
          role: 'user',
          status: 'active'
        })

      const { statusCode } = await removeFrom(team, insertedId.toString())
      const [event] = await events(team.teamId, 'team.removeMember')

      expect(statusCode).toBe(204)
      expect(event.outcome).toBe('success')
      expect(event).not.toHaveProperty('subjectOid')
    })

    test('removes one of two admins', async () => {
      const team = await seedTeam({ admins: 2 })

      const { statusCode } = await removeFrom(team, team.members[0].memberId)

      expect(statusCode).toBe(204)
    })

    test('refuses the last admin with 409 last-admin, and removes nobody', async () => {
      const team = await seedTeam({ admins: 1, users: 2 })

      const { statusCode, result } = await removeFrom(
        team,
        team.members[0].memberId
      )

      expect(statusCode).toBe(409)
      expect(result.code).toBe('last-admin')
      expect(await activeMembers(team.teamId)).toBe(3)
      expect(await events(team.teamId, 'team.removeMember')).toEqual([])
    })

    test.each([['disabled'], ['pending-removal']])(
      'removes from a %s team',
      async (status) => {
        const team = await seedTeam({ status, users: 1 })

        const { statusCode } = await removeFrom(team, team.members[1].memberId)

        expect(statusCode).toBe(204)
      }
    )

    test('answers 404 member-not-found for a member already removed, one of another team, or an id that is not one', async () => {
      const team = await seedTeam({ admins: 2 })
      const other = await seedTeam({ admins: 2 })

      await removeFrom(team, team.members[0].memberId)

      for (const memberId of [
        team.members[0].memberId,
        other.members[0].memberId,
        'not-an-object-id',
        '507f1f77bcf86cd799439011'
      ]) {
        const { statusCode, result } = await removeFrom(team, memberId)

        expect(statusCode).toBe(404)
        expect(result.code).toBe('member-not-found')
      }

      expect(await activeMembers(other.teamId)).toBe(2)
    })

    test('answers 404 team-not-found for a team nobody has', async () => {
      const { statusCode, result } = await call({
        method: 'DELETE',
        url: '/v1/admin/teams/no-such-team/members/507f1f77bcf86cd799439011'
      })

      expect(statusCode).toBe(404)
      expect(result.code).toBe('team-not-found')
    })

    test('refuses a person who is not a Platform Admin with 403 and an access.denied event, and removes nobody', async () => {
      const team = await seedTeam({ admins: 2 })

      const { statusCode, result } = await removeFrom(
        team,
        team.members[0].memberId,
        { headers: authFor('admin-members-plain') }
      )

      expect(statusCode).toBe(403)
      expect(result.code).toBe('platform-admin-required')
      expect(await activeMembers(team.teamId)).toBe(2)
      expect(await events(team.teamId, 'access.denied')).toHaveLength(1)
    })
  })

  describe('the built team routes', () => {
    test('still answer 404 to a non-member (a Platform Admin is no team member) and 403 admin-required to a member who is not an admin', async () => {
      const team = await seedTeam({ admins: 1, users: 1 })

      const outsider = await call({
        method: 'POST',
        url: `/v1/teams/${team.teamId}/members`,
        headers: asAdmin('admin-members-outsider'),
        payload: { oid: SEEDED.journey, role: 'user' },
        key: randomUUID()
      })
      const plainMember = await call({
        method: 'POST',
        url: `/v1/teams/${team.teamId}/members`,
        headers: authFor(team.members[1].userId),
        payload: { oid: SEEDED.journey, role: 'user' },
        key: randomUUID()
      })

      expect(outsider.statusCode).toBe(404)
      expect(plainMember.statusCode).toBe(403)
      expect(plainMember.result.code).toBe('admin-required')
      expect(await activeMembers(team.teamId)).toBe(2)
    })

    test('record the team and role on a team Admin’s add and removal, as before', async () => {
      const team = await seedTeam({ admins: 1, users: 1 })
      const headers = authFor(team.members[0].userId)

      const add = await call({
        method: 'POST',
        url: `/v1/teams/${team.teamId}/members`,
        headers,
        payload: { oid: SEEDED.journey, role: 'user' },
        key: randomUUID()
      })
      const remove = await call({
        method: 'DELETE',
        url: `/v1/teams/${team.teamId}/members/${team.members[1].memberId}`,
        headers
      })

      expect(add.statusCode).toBe(201)
      expect(remove.statusCode).toBe(204)
      expect((await events(team.teamId, 'team.addMember'))[0].role).toBe(
        'admin'
      )
      expect((await events(team.teamId, 'team.removeMember'))[0].role).toBe(
        'admin'
      )
    })

    test('answer 404 member-not-found when a team Admin removes someone who is not a member', async () => {
      const team = await seedTeam({ admins: 1 })

      const { statusCode, result } = await call({
        method: 'DELETE',
        url: `/v1/teams/${team.teamId}/members/507f1f77bcf86cd799439011`,
        headers: authFor(team.members[0].userId)
      })

      expect(statusCode).toBe(404)
      expect(result.code).toBe('member-not-found')
    })
  })
})
