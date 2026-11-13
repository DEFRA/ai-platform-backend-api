import { randomUUID } from 'node:crypto'

import {
  authFor,
  appAuth,
  withTestUsers
} from '#/common/test-helpers/portal-token.js'

const ADMIN_ROLES = ['research-user', 'platform-admin']
const ADMIN = 'admin-teams-admin'

describe('#admin teams reads', () => {
  let server
  let config
  let createLogger
  let mockTeamFileReader
  let configuredEnvironments

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    withTestUsers(server)
    ;({ config } = await import('#/config.js'))
    ;({ createLogger } = await import('#/common/helpers/logging/logger.js'))
    ;({ mockTeamFileReader } =
      await import('#/adapters/mock-team-file-reader.js'))
    configuredEnvironments = config.get('teamDeployment.environments')
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  afterEach(() => {
    config.set('teamDeployment.environments', configuredEnvironments)
    vi.restoreAllMocks()
  })

  const asAdmin = () => authFor(ADMIN, { roles: ADMIN_ROLES })

  function get(url, headers = asAdmin()) {
    return server.inject({ method: 'GET', url, headers })
  }

  // A team the way the API stores it. `status` is left out to make a team
  // that predates the field.
  async function insertTeam({ name, status, serviceCode = 'ABC' }) {
    const slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')
    const { insertedId } = await server.db.collection('teams').insertOne({
      name,
      normalisedName: name.toLowerCase().trim().replaceAll(/\s+/g, '-'),
      slug,
      serviceCode,
      createdBy: 'seed',
      ...(status && { status })
    })

    return { id: insertedId.toString(), slug, name }
  }

  async function addMembers(teamId, count) {
    const members = Array.from({ length: count }, (_, index) => ({
      teamId,
      userId: `member-${randomUUID()}-${index}`,
      role: index === 0 ? 'admin' : 'user',
      status: 'active'
    }))

    await server.db.collection('teamMembers').insertMany(members)
  }

  async function addEnvironment(teamId, environment) {
    await server.db
      .collection('teamDeployments')
      .insertOne({ teamId, environment, deployments: [] })
  }

  function denials() {
    return server.db
      .collection('auditEvents')
      .find({ action: 'access.denied', code: 'platform-admin-required' })
      .toArray()
  }

  function tenantFiles(files) {
    vi.spyOn(mockTeamFileReader, 'getCurrentDocument').mockImplementation(
      async ({ path }) => ({ document: files[path] ?? null })
    )
  }

  describe('GET /v1/admin/teams', () => {
    test('lists teams by name with their status, environments and active member count', async () => {
      const prefix = `zl-${randomUUID().slice(0, 6)}`
      const beta = await insertTeam({
        name: `${prefix} Beta`,
        status: 'disabled'
      })
      const alpha = await insertTeam({ name: `${prefix} Alpha` })

      await addMembers(alpha.id, 3)
      config.set('teamDeployment.environments', ['infradev', 'sandbox'])
      await server.db.collection('teamMembers').insertOne({
        teamId: alpha.id,
        userId: 'gone',
        role: 'user',
        status: 'removed'
      })
      await addEnvironment(alpha.id, 'sandbox')
      await addEnvironment(alpha.id, 'infradev')

      const { statusCode, result } = await get(
        `/v1/admin/teams?search=${prefix}`
      )

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        teams: [
          {
            id: alpha.id,
            name: `${prefix} Alpha`,
            slug: alpha.slug,
            status: 'active',
            environments: ['infradev', 'sandbox'],
            memberCount: 3
          },
          {
            id: beta.id,
            name: `${prefix} Beta`,
            slug: beta.slug,
            status: 'disabled',
            environments: [],
            memberCount: 0
          }
        ],
        page: 1,
        pageSize: 25,
        total: 2
      })
    })

    test('lists the environments in the configured order', async () => {
      const team = await insertTeam({ name: `zo-${randomUUID().slice(0, 6)}` })

      config.set('teamDeployment.environments', ['qa', 'infradev'])
      await addEnvironment(team.id, 'infradev')
      await addEnvironment(team.id, 'qa')
      await addEnvironment(team.id, 'aaa-unlisted')

      const { result } = await get(`/v1/admin/teams?search=${team.slug}`)

      expect(result.teams[0].environments).toEqual([
        'qa',
        'infradev',
        'aaa-unlisted'
      ])
    })

    test('pages 25 at a time, in name order, with the total', async () => {
      const prefix = `zp-${randomUUID().slice(0, 6)}`

      for (let index = 0; index < 30; index++) {
        await insertTeam({
          name: `${prefix} ${String(index).padStart(2, '0')}`,
          status: index % 2 ? 'disabled' : 'active'
        })
      }

      const first = await get(`/v1/admin/teams?search=${prefix}`)
      const second = await get(`/v1/admin/teams?search=${prefix}&page=2`)
      const beyond = await get(`/v1/admin/teams?search=${prefix}&page=3`)

      expect(first.result.teams).toHaveLength(25)
      expect(first.result.total).toBe(30)
      expect(first.result.teams[0].name).toBe(`${prefix} 00`)
      expect(first.result.teams[24].name).toBe(`${prefix} 24`)
      expect(second.result.page).toBe(2)
      expect(second.result.teams.map(({ name }) => name)).toEqual([
        `${prefix} 25`,
        `${prefix} 26`,
        `${prefix} 27`,
        `${prefix} 28`,
        `${prefix} 29`
      ])
      expect(beyond.statusCode).toBe(200)
      expect(beyond.result.teams).toEqual([])
      expect(beyond.result.total).toBe(30)
    })

    test('answers a page of 25 teams in under a second', async () => {
      const prefix = `zt-${randomUUID().slice(0, 6)}`

      for (let index = 0; index < 25; index++) {
        const team = await insertTeam({ name: `${prefix} ${index}` })

        await addMembers(team.id, 2)
        await addEnvironment(team.id, 'infradev')
      }

      const started = performance.now()
      const { statusCode, result } = await get(
        `/v1/admin/teams?search=${prefix}`
      )

      expect(statusCode).toBe(200)
      expect(result.teams).toHaveLength(25)
      expect(performance.now() - started).toBeLessThan(1000)
    })

    test('answers an empty page, not an error, when nothing matches', async () => {
      const { statusCode, result } = await get(
        '/v1/admin/teams?search=zz-no-such-team-anywhere'
      )

      expect(statusCode).toBe(200)
      expect(result).toEqual({ teams: [], page: 1, pageSize: 25, total: 0 })
    })

    test('filters by status, and counts a team with no status as active', async () => {
      const prefix = `zs-${randomUUID().slice(0, 6)}`

      await insertTeam({ name: `${prefix} none` })
      await insertTeam({ name: `${prefix} active`, status: 'active' })
      await insertTeam({ name: `${prefix} disabled`, status: 'disabled' })
      await insertTeam({ name: `${prefix} pending`, status: 'pending-removal' })

      const names = async (status) =>
        (
          await get(`/v1/admin/teams?search=${prefix}&status=${status}`)
        ).result.teams.map(({ name }) => name.replace(`${prefix} `, ''))

      expect(await names('active')).toEqual(['active', 'none'])
      expect(await names('disabled')).toEqual(['disabled'])
      expect(await names('pending-removal')).toEqual(['pending'])
    })

    test('searches by name as typed, in any case and with spaces for hyphens', async () => {
      const unique = randomUUID().slice(0, 6)

      await insertTeam({ name: `Flood Risk ${unique}` })

      const { result } = await get(
        `/v1/admin/teams?search=${encodeURIComponent(`FLOOD risk ${unique}`)}`
      )

      expect(result.teams.map(({ name }) => name)).toEqual([
        `Flood Risk ${unique}`
      ])
    })

    test('matches regular expression characters in a search literally', async () => {
      const unique = randomUUID().slice(0, 6)

      await insertTeam({ name: `ax${unique}b` })
      await insertTeam({ name: `a.${unique}b` })

      const dot = await get(
        `/v1/admin/teams?search=${encodeURIComponent(`a.${unique}`)}`
      )
      const wildcard = await get(
        `/v1/admin/teams?search=${encodeURIComponent('.*')}`
      )
      const bracket = await get(
        `/v1/admin/teams?search=${encodeURIComponent('(a[')}`
      )

      expect(dot.result.teams.map(({ name }) => name)).toEqual([`a.${unique}b`])
      expect(wildcard.statusCode).toBe(200)
      expect(wildcard.result.teams).toEqual([])
      expect(bracket.statusCode).toBe(200)
      expect(bracket.result.teams).toEqual([])
    })

    test.each([
      ['a search of one character', 'search=a'],
      ['a search of 101 characters', `search=${'a'.repeat(101)}`],
      ['a status that is not one', 'status=archived'],
      ['a page of zero', 'page=0'],
      ['a page that is not a number', 'page=first'],
      ['a page that is not whole', 'page=1.5'],
      ['a query key nobody asked for', 'sort=desc']
    ])('refuses %s with 400 invalid-query', async (_name, query) => {
      const { statusCode, result } = await get(`/v1/admin/teams?${query}`)

      expect(statusCode).toBe(400)
      expect(result.code).toBe('invalid-query')
    })

    test('does not echo, store or log a refused search', async () => {
      const warn = vi.spyOn(createLogger(), 'warn').mockImplementation(() => {})
      const secret = `s${'x'.repeat(100)}`

      const { result } = await get(`/v1/admin/teams?search=${secret}`)

      expect(JSON.stringify(result)).not.toContain(secret)
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
    })

    test('refuses a person who is not a Platform Admin with 403, an access.denied event, and reads nothing', async () => {
      const before = (await denials()).length

      const { statusCode, result } = await get(
        '/v1/admin/teams',
        authFor('admin-teams-plain')
      )

      expect(statusCode).toBe(403)
      expect(result.code).toBe('platform-admin-required')
      expect(result).not.toHaveProperty('teams')
      expect(await denials()).toHaveLength(before + 1)
    })

    test('refuses a role removed since the last call at the next request, with no new sign-in', async () => {
      const label = 'admin-teams-demoted'

      expect(
        (await get('/v1/admin/teams', authFor(label, { roles: ADMIN_ROLES })))
          .statusCode
      ).toBe(200)

      await server.db
        .collection('users')
        .updateOne({ _id: label }, { $set: { roles: ['research-user'] } })

      const { statusCode, result } = await get(
        '/v1/admin/teams',
        authFor(label)
      )

      expect(statusCode).toBe(403)
      expect(result.code).toBe('platform-admin-required')
    })

    test('refuses the frontend’s own app-only token, which no admin route accepts', async () => {
      const { statusCode } = await get('/v1/admin/teams', appAuth())

      expect(statusCode).toBe(401)
    })

    test('refuses a request with no token', async () => {
      const { statusCode } = await get('/v1/admin/teams', {})

      expect(statusCode).toBe(401)
    })
  })

  describe('GET /v1/admin/teams/{id}', () => {
    async function seedTeam(status) {
      const team = await insertTeam({
        name: `zd-${randomUUID().slice(0, 6)}`,
        status
      })
      const { insertedId: personId } = await server.db
        .collection('users')
        .insertOne({
          oid: randomUUID(),
          email: 'member.person@defra.gov.uk',
          displayName: 'Member Person'
        })

      await server.db.collection('teamMembers').insertOne({
        teamId: team.id,
        userId: personId.toString(),
        role: 'admin',
        status: 'active'
      })
      await server.db.collection('teamMembers').insertOne({
        teamId: team.id,
        userId: 'someone-removed',
        role: 'user',
        status: 'removed'
      })

      return { ...team, personId: personId.toString() }
    }

    test('shows the team, each environment’s file status and removal date, and the members as the team page shows them', async () => {
      const team = await seedTeam('pending-removal')

      config.set('teamDeployment.environments', ['infradev', 'qa', 'prod'])
      tenantFiles({
        [`environments/infradev/${team.slug}.json`]: {
          status: 'pending-removal',
          removeAfter: '2026-12-01'
        },
        [`environments/qa/${team.slug}.json`]: { status: 'active' }
      })

      const { statusCode, result } = await get(`/v1/admin/teams/${team.id}`)

      expect(statusCode).toBe(200)
      expect(result.team).toEqual({
        id: team.id,
        name: team.name,
        slug: team.slug,
        serviceCode: 'ABC',
        status: 'pending-removal',
        environments: [
          {
            environment: 'infradev',
            fileStatus: 'pending-removal',
            removeAfter: '2026-12-01'
          },
          { environment: 'qa', fileStatus: 'active' }
        ]
      })
      expect(result.members).toHaveLength(1)
      expect(result.members[0]).toMatchObject({
        teamId: team.id,
        userId: team.personId,
        role: 'admin',
        status: 'active',
        displayName: 'Member Person',
        email: 'member.person@defra.gov.uk'
      })
    })

    test('reads a team by its slug as well as its id, and a file with no status as null', async () => {
      const team = await seedTeam()

      config.set('teamDeployment.environments', ['infradev'])
      tenantFiles({ [`environments/infradev/${team.slug}.json`]: {} })

      const { statusCode, result } = await get(`/v1/admin/teams/${team.slug}`)

      expect(statusCode).toBe(200)
      expect(result.team.id).toBe(team.id)
      expect(result.team.environments).toEqual([
        { environment: 'infradev', fileStatus: null }
      ])
    })

    test.each([['disabled'], ['active'], [undefined]])(
      'shows a team whose status is %s, and reads an absent status as active',
      async (status) => {
        const team = await seedTeam(status)

        tenantFiles({})

        const { result } = await get(`/v1/admin/teams/${team.id}`)

        expect(result.team.status).toBe(status ?? 'active')
      }
    )

    test('answers 404 team-not-found for a team nobody has, whatever its shape', async () => {
      for (const id of ['507f1f77bcf86cd799439011', 'no-such-team', 'A!']) {
        const { statusCode, result } = await get(`/v1/admin/teams/${id}`)

        expect(statusCode).toBe(404)
        expect(result.code).toBe('team-not-found')
      }
    })

    test('answers 502 upstream-unavailable when a team file cannot be read, not an empty list', async () => {
      const team = await seedTeam()

      vi.spyOn(mockTeamFileReader, 'getCurrentDocument').mockRejectedValue(
        new Error('GitHub is down')
      )

      const { statusCode, result } = await get(`/v1/admin/teams/${team.id}`)

      expect(statusCode).toBe(502)
      expect(result.code).toBe('upstream-unavailable')
    })

    test('refuses a person who is not a Platform Admin with 403 and an access.denied event, before it reads the team or its files', async () => {
      const team = await seedTeam()
      const before = (await denials()).length

      tenantFiles({})

      const { statusCode, result } = await get(
        `/v1/admin/teams/${team.id}`,
        authFor('admin-teams-plain')
      )

      expect(statusCode).toBe(403)
      expect(result.code).toBe('platform-admin-required')
      expect(mockTeamFileReader.getCurrentDocument).not.toHaveBeenCalled()
      expect(await denials()).toHaveLength(before + 1)
    })

    test('refuses a person who is not a Platform Admin even for a team that does not exist', async () => {
      const { statusCode } = await get(
        '/v1/admin/teams/no-such-team',
        authFor('admin-teams-plain')
      )

      expect(statusCode).toBe(403)
    })
  })
})
