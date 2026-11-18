import { randomUUID } from 'node:crypto'

import { authFor, withTestUsers } from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

const ADMIN = 'status-changes-admin'

describe('#team status-changes route', () => {
  let server
  let fixtures

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    withTestUsers(server)
    fixtures = createTeamFixtures(server)
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  const asPlatformAdmin = () =>
    authFor(ADMIN, { roles: ['research-user', 'platform-admin'] })

  async function teamWithMember(label) {
    const team = await fixtures.newTeam(label)

    await fixtures.addMember(team, `${label}-member`, 'user')

    return { ...team, member: `${label}-member` }
  }

  // An audit row as the admin routes write it, `minute` minutes into the hour.
  function seedRow(team, { minute, action, environments, outcome, reason }) {
    return server.db.collection('auditEvents').insertOne({
      at: new Date(Date.UTC(2026, 10, 16, 10, minute)),
      actorUserId: ADMIN,
      oid: 'admin-oid',
      role: 'platform-admin',
      action,
      resource: 'team',
      resourceId: team.teamId,
      teamId: team.teamId,
      outcome: outcome ?? 'success',
      reason: reason ?? 'A private reason',
      ...(environments && { environments })
    })
  }

  function read(team, label, query = '') {
    return server.inject({
      method: 'GET',
      url: `/v1/teams/${team.slug}/status-changes${query}`,
      headers: fixtures.as(label)
    })
  }

  test('lists the disables and enables of the team, newest first, as change, environments and time', async () => {
    const team = await teamWithMember('sc-list-1')

    await seedRow(team, {
      minute: 1,
      action: 'admin.team.disable',
      environments: ['sandbox']
    })
    await seedRow(team, {
      minute: 5,
      action: 'admin.team.enable',
      environments: []
    })

    const { statusCode, result } = await read(team, team.member)

    expect(statusCode).toBe(200)
    expect(result).toEqual({
      items: [
        {
          change: 'enabled',
          environments: [],
          at: '2026-11-16T10:05:00.000Z'
        },
        {
          change: 'disabled',
          environments: ['sandbox'],
          at: '2026-11-16T10:01:00.000Z'
        }
      ]
    })
  })

  test('is empty for a team that was never disabled', async () => {
    const team = await teamWithMember('sc-empty-1')

    const { statusCode, result } = await read(team, team.admin)

    expect(statusCode).toBe(200)
    expect(result).toEqual({ items: [] })
  })

  test('never shows the reason, who did it, or any other key', async () => {
    const team = await teamWithMember('sc-private-1')

    await seedRow(team, {
      minute: 1,
      action: 'admin.team.disable',
      environments: ['sandbox'],
      reason: 'Secret reason text'
    })

    const { result } = await read(team, team.member)
    const text = JSON.stringify(result)

    expect(Object.keys(result.items[0]).sort()).toEqual([
      'at',
      'change',
      'environments'
    ])
    expect(text).not.toContain('Secret reason text')
    expect(text).not.toContain(ADMIN)
    expect(text).not.toContain('admin-oid')
    expect(text).not.toContain('@')
  })

  test('shows only the changes that were made, other actions and other teams’ rows left out', async () => {
    const team = await teamWithMember('sc-only-1')
    const other = await teamWithMember('sc-only-2')

    await seedRow(team, {
      minute: 1,
      action: 'admin.team.disable',
      environments: []
    })
    await seedRow(team, {
      minute: 2,
      action: 'admin.team.disable',
      environments: [],
      outcome: 'failure'
    })
    await seedRow(team, { minute: 3, action: 'admin.credentials.disable' })
    await seedRow(other, {
      minute: 4,
      action: 'admin.team.enable',
      environments: []
    })

    const { result } = await read(team, team.member)

    expect(result.items).toEqual([
      { change: 'disabled', environments: [], at: '2026-11-16T10:01:00.000Z' }
    ])
  })

  test('keeps the changes that name the environment asked for', async () => {
    const team = await teamWithMember('sc-env-1')

    await seedRow(team, {
      minute: 1,
      action: 'admin.team.disable',
      environments: ['sandbox', 'infradev']
    })
    await seedRow(team, {
      minute: 2,
      action: 'admin.team.disable',
      environments: ['infradev']
    })
    await seedRow(team, {
      minute: 3,
      action: 'admin.team.enable',
      environments: []
    })

    const { result } = await read(team, team.member, '?environment=sandbox')

    expect(result.items.map(({ at }) => at)).toEqual([
      '2026-11-16T10:01:00.000Z'
    ])
  })

  test('reads a row with no environments as none', async () => {
    const team = await teamWithMember('sc-none-1')

    await seedRow(team, { minute: 1, action: 'admin.team.enable' })

    const { result } = await read(team, team.member)

    expect(result.items[0].environments).toEqual([])
  })

  test('returns the 10 newest by default and as many as asked up to 50', async () => {
    const team = await teamWithMember('sc-limit-1')

    for (let minute = 0; minute < 12; minute++) {
      await seedRow(team, {
        minute,
        action: 'admin.team.enable',
        environments: []
      })
    }

    const byDefault = await read(team, team.member)
    const two = await read(team, team.member, '?limit=2')
    const most = await read(team, team.member, '?limit=50')

    expect(byDefault.result.items).toHaveLength(10)
    expect(byDefault.result.items[0].at).toBe('2026-11-16T10:11:00.000Z')
    expect(two.result.items.map(({ at }) => at)).toEqual([
      '2026-11-16T10:11:00.000Z',
      '2026-11-16T10:10:00.000Z'
    ])
    expect(most.result.items).toHaveLength(12)
  })

  test.each([
    ['a limit of zero', '?limit=0'],
    ['a limit of 51', '?limit=51'],
    ['a limit that is not a number', '?limit=many'],
    ['a limit that is not whole', '?limit=1.5'],
    ['an environment that is not a name', '?environment=Not%20A%20Name'],
    ['a query key nobody asked for', '?page=2']
  ])('refuses %s with 400 invalid-query', async (_name, query) => {
    const team = await teamWithMember(`sc-bad-${randomUUID().slice(0, 6)}`)

    const { statusCode, result } = await read(team, team.member, query)

    expect(statusCode).toBe(400)
    expect(result.code).toBe('invalid-query')
  })

  test('is 404, audited, for a person who is not a member, even a Platform Admin', async () => {
    const team = await teamWithMember('sc-deny-1')

    await fixtures.signIn('sc-deny-1-outsider')

    const outsider = await read(team, 'sc-deny-1-outsider')
    const admin = await server.inject({
      method: 'GET',
      url: `/v1/teams/${team.slug}/status-changes`,
      headers: asPlatformAdmin()
    })

    expect(outsider.statusCode).toBe(404)
    expect(admin.statusCode).toBe(404)
    expect(
      await server.db.collection('auditEvents').countDocuments({
        action: 'access.denied',
        code: 'not-a-member',
        resourceId: team.teamId
      })
    ).toBe(2)
  })

  test('is 404 for a team nobody holds, and 401 with no token', async () => {
    const missing = await server.inject({
      method: 'GET',
      url: '/v1/teams/no-such-team/status-changes',
      headers: asPlatformAdmin()
    })
    const anonymous = await server.inject({
      method: 'GET',
      url: '/v1/teams/any/status-changes'
    })

    expect(missing.statusCode).toBe(404)
    expect(anonymous.statusCode).toBe(401)
  })
})
