import { ObjectId } from 'mongodb'

import { authFor, withTestUsers } from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

const ADMIN_ROLES = ['research-user', 'platform-admin']

describe('#usage routes', () => {
  let server
  let config
  let reader
  let configuredEnvironments
  let fixtures
  let readUsage

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')

    ;({ config } = await import('#/config.js'))
    ;({
      usageReaderRegistry: { current: reader }
    } = await import('#/adapters/usage-reader-registry.js'))
    server = await createServer()
    await server.initialize()
    withTestUsers(server)
    fixtures = createTeamFixtures(server)
    configuredEnvironments = config.get('teamDeployment.environments')
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  beforeEach(() => {
    config.set('teamDeployment.environments', ['infradev', 'qa'])
    readUsage = vi.spyOn(reader, 'readUsage')
  })

  afterEach(() => {
    config.set('teamDeployment.environments', configuredEnvironments)
    vi.restoreAllMocks()
  })

  function getTeamUsage(
    team,
    label,
    { environment = 'infradev', query = '' } = {}
  ) {
    return server.inject({
      method: 'GET',
      url: `/v1/teams/${team.slug}/environments/${environment}/usage${query}`,
      headers: fixtures.as(label)
    })
  }

  function getAdminUsage(
    headers,
    { environment = 'infradev', query = '' } = {}
  ) {
    return server.inject({
      method: 'GET',
      url: `/v1/admin/environments/${environment}/usage${query}`,
      headers
    })
  }

  describe('a team', () => {
    test('shows a member their own team: totals, every day and each model', async () => {
      const team = await fixtures.newTeam('usage-1-admin')
      await fixtures.addMember(team, 'usage-1-member', 'user')

      const { statusCode, result } = await getTeamUsage(team, 'usage-1-member')

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        teamId: team.teamId,
        environment: 'infradev',
        source: 'mock',
        costBasis: { estimate: true, currency: 'USD' }
      })
      expect(result.period.days).toBe(30)
      expect(result.byDay).toHaveLength(30)
      expect(result.byModel.length).toBeGreaterThan(0)
      expect(result.totals.totalTokens).toBe(
        result.byDay.reduce((sum, day) => sum + day.totalTokens, 0)
      )
      expect(result.totals.totalTokens).toBe(
        result.byModel.reduce((sum, model) => sum + model.totalTokens, 0)
      )
    })

    test('asks the reader for this team alone, by its own slug', async () => {
      const team = await fixtures.newTeam('usage-2-admin')

      await getTeamUsage(team, 'usage-2-admin')

      expect(readUsage).toHaveBeenCalledTimes(1)
      expect(readUsage.mock.calls[0][0]).toMatchObject({
        environment: 'infradev',
        teamSlug: team.slug
      })
    })

    test('shows the same to an Admin as to a Member', async () => {
      const team = await fixtures.newTeam('usage-3-admin')
      await fixtures.addMember(team, 'usage-3-member', 'user')

      const asAdmin = await getTeamUsage(team, 'usage-3-admin')
      const asMember = await getTeamUsage(team, 'usage-3-member')

      expect(asMember.result).toEqual(asAdmin.result)
    })

    test.each([
      [7, 7],
      [90, 90]
    ])('takes %i days', async (days, expected) => {
      const team = await fixtures.newTeam(`usage-4-admin-${days}`)

      const { statusCode, result } = await getTeamUsage(
        team,
        `usage-4-admin-${days}`,
        {
          query: `?days=${days}`
        }
      )

      expect(statusCode).toBe(200)
      expect(result.byDay).toHaveLength(expected)
    })

    test.each(['?days=5', '?days=abc', '?days=30&extra=1'])(
      'refuses the query %s with 400 invalid-query, reading nothing',
      async (query) => {
        const team = await fixtures.newTeam('usage-5-admin')

        const { statusCode, result } = await getTeamUsage(
          team,
          'usage-5-admin',
          { query }
        )

        expect(statusCode).toBe(400)
        expect(result.code).toBe('invalid-query')
        expect(readUsage).not.toHaveBeenCalled()
      }
    )

    test('is not found for someone outside the team, audited, and reads nothing', async () => {
      const team = await fixtures.newTeam('usage-6-admin')
      await fixtures.signIn('usage-6-stranger')

      const { statusCode } = await getTeamUsage(team, 'usage-6-stranger')

      expect(statusCode).toBe(404)
      expect(readUsage).not.toHaveBeenCalled()
      expect(
        await server.db
          .collection('auditEvents')
          .countDocuments({ action: 'access.denied', resourceId: team.teamId })
      ).toBeGreaterThan(0)
    })

    test("never asks for another team's usage, even by that team's id or slug", async () => {
      const mine = await fixtures.newTeam('usage-7-mine')
      const theirs = await fixtures.newTeam('usage-7-theirs')

      const byId = await server.inject({
        method: 'GET',
        url: `/v1/teams/${theirs.teamId}/environments/infradev/usage`,
        headers: fixtures.as('usage-7-mine')
      })
      const bySlug = await getTeamUsage(theirs, 'usage-7-mine')
      const own = await getTeamUsage(mine, 'usage-7-mine')

      expect(byId.statusCode).toBe(404)
      expect(bySlug.statusCode).toBe(404)
      expect(own.statusCode).toBe(200)
      expect(readUsage.mock.calls.map(([query]) => query.teamSlug)).toEqual([
        mine.slug
      ])
    })

    test('is not found for an environment this instance does not offer', async () => {
      const team = await fixtures.newTeam('usage-8-admin')

      const { statusCode, result } = await getTeamUsage(team, 'usage-8-admin', {
        environment: 'dev'
      })

      expect(statusCode).toBe(404)
      expect(result.code).toBe('environment-not-available')
      expect(readUsage).not.toHaveBeenCalled()
    })

    test('says so when the environment has no usage source', async () => {
      const team = await fixtures.newTeam('usage-9-admin')
      readUsage.mockRejectedValue(
        Object.assign(new Error('no workspace'), {
          code: 'usage-not-available'
        })
      )

      const { statusCode, result } = await getTeamUsage(team, 'usage-9-admin')

      expect(statusCode).toBe(404)
      expect(result.code).toBe('usage-not-available')
    })

    test('answers 502 upstream-unavailable, with no detail, when the source fails', async () => {
      const team = await fixtures.newTeam('usage-10-admin')
      readUsage.mockRejectedValue(
        new Error('workspace law-secret-name refused')
      )

      const { statusCode, result } = await getTeamUsage(team, 'usage-10-admin')

      expect(statusCode).toBe(502)
      expect(result.code).toBe('upstream-unavailable')
      expect(JSON.stringify(result)).not.toContain('law-secret-name')
    })

    test('prices a model it knows and leaves one it does not without a cost', async () => {
      const team = await fixtures.newTeam('usage-11-admin')
      const day = new Date().toISOString().slice(0, 10)
      readUsage.mockResolvedValue([
        {
          day,
          teamSlug: team.slug,
          deployment: `${team.slug}-gpt-4o`,
          requests: 2,
          promptTokens: 1_000_000,
          completionTokens: 100_000
        },
        {
          day,
          teamSlug: team.slug,
          deployment: `${team.slug}-unheard-of`,
          requests: 1,
          promptTokens: 10,
          completionTokens: 1
        }
      ])

      const { result } = await getTeamUsage(team, 'usage-11-admin')

      expect(result.totals).toMatchObject({
        requests: 3,
        totalTokens: 1_100_011
      })
      expect(
        result.byModel.find((m) => m.modelSlug === 'gpt-4o').estimatedCost
      ).toBeCloseTo(3.5)
      expect(
        result.byModel.find((m) => m.modelSlug === 'unheard-of').estimatedCost
      ).toBeNull()
      expect(result.unpricedModels).toEqual(['unheard-of'])
    })

    test('never reads the Research tier as a team, even for a team that holds its slug', async () => {
      const team = await fixtures.newTeam('usage-13-admin')

      await server.db
        .collection('teams')
        .updateOne(
          { _id: new ObjectId(team.teamId) },
          { $set: { slug: 'research' } }
        )

      const { statusCode, result } = await server.inject({
        method: 'GET',
        url: `/v1/teams/${team.teamId}/environments/infradev/usage`,
        headers: fixtures.as('usage-13-admin')
      })

      expect(statusCode).toBe(404)
      expect(result.code).toBe('usage-not-available')
      expect(readUsage).not.toHaveBeenCalled()
    })

    test('does not give a new team the slug of the Research tier', async () => {
      await fixtures.signIn('usage-14-admin')

      const { statusCode, result } = await server.inject({
        method: 'POST',
        url: '/v1/teams',
        headers: fixtures.asWithKey('usage-14-admin'),
        payload: { name: 'Research', serviceCode: 'ABC' }
      })

      expect(statusCode).toBe(201)
      expect(result.team.slug).not.toBe('research')
      expect(result.team.slug.startsWith('research')).toBe(true)
    })

    test('leaves a total with no cost when one of its models has no price', async () => {
      const team = await fixtures.newTeam('usage-15-admin')
      const day = new Date().toISOString().slice(0, 10)

      readUsage.mockResolvedValue([
        {
          day,
          teamSlug: team.slug,
          deployment: `${team.slug}-gpt-4o`,
          requests: 1,
          promptTokens: 1000000,
          completionTokens: 0
        },
        {
          day,
          teamSlug: team.slug,
          deployment: `${team.slug}-unheard-of`,
          requests: 1,
          promptTokens: 10,
          completionTokens: 0
        }
      ])

      const { result } = await getTeamUsage(team, 'usage-15-admin')

      expect(result.totals.estimatedCost).toBeNull()
      expect(result.unpricedModels).toEqual(['unheard-of'])
      expect(
        result.byModel.find((m) => m.modelSlug === 'gpt-4o').estimatedCost
      ).toBeCloseTo(2.5)
    })

    test('needs a signed-in person', async () => {
      const team = await fixtures.newTeam('usage-12-admin')

      const { statusCode } = await server.inject({
        method: 'GET',
        url: `/v1/teams/${team.slug}/environments/infradev/usage`
      })

      expect(statusCode).toBe(401)
    })
  })

  describe('a Platform Admin', () => {
    test('refuses anyone else with 403, audited, and reads nothing', async () => {
      const denials = () =>
        server.db.collection('auditEvents').countDocuments({
          action: 'access.denied',
          code: 'platform-admin-required'
        })
      const before = await denials()
      const { statusCode, result } = await getAdminUsage(
        authFor('usage-admin-plain')
      )

      expect(statusCode).toBe(403)
      expect(result.code).toBe('platform-admin-required')
      expect(readUsage).not.toHaveBeenCalled()
      expect(await denials()).toBe(before + 1)
    })

    test('sees every team, those with no calls too, and the APIs no team owns', async () => {
      const busy = await fixtures.newTeam('usage-admin-busy')
      const quiet = await fixtures.newTeam('usage-admin-quiet')
      const day = new Date().toISOString().slice(0, 10)
      readUsage.mockResolvedValue([
        {
          day,
          teamSlug: busy.slug,
          deployment: `${busy.slug}-gpt-4o`,
          requests: 4,
          promptTokens: 400,
          completionTokens: 40
        },
        {
          day,
          teamSlug: 'research',
          deployment: 'research-gpt-4o',
          requests: 1,
          promptTokens: 10,
          completionTokens: 1
        }
      ])

      const { statusCode, result } = await getAdminUsage(
        authFor('usage-admin', { roles: ADMIN_ROLES })
      )

      expect(statusCode).toBe(200)
      expect(readUsage.mock.calls[0][0].teamSlug).toBeUndefined()

      const busyRow = result.teams.find((team) => team.slug === busy.slug)
      const quietRow = result.teams.find((team) => team.slug === quiet.slug)

      expect(busyRow).toMatchObject({
        teamId: busy.teamId,
        serviceCode: 'ABC',
        requests: 4,
        totalTokens: 440
      })
      expect(quietRow).toMatchObject({ requests: 0, totalTokens: 0 })
      expect(result.teams.indexOf(busyRow)).toBeLessThan(
        result.teams.indexOf(quietRow)
      )
      expect(result.otherApis).toEqual([
        expect.objectContaining({
          apiId: 'research',
          requests: 1,
          totalTokens: 11
        })
      ])
      expect(result.costBasis.estimate).toBe(true)
    })

    test('lists the APIs no team owns by tokens, largest first', async () => {
      const day = new Date().toISOString().slice(0, 10)
      readUsage.mockResolvedValue([
        {
          day,
          teamSlug: 'small-api',
          deployment: 'small-api-gpt-4o',
          requests: 1,
          promptTokens: 1,
          completionTokens: 1
        },
        {
          day,
          teamSlug: 'big-api',
          deployment: 'big-api-gpt-4o',
          requests: 1,
          promptTokens: 500,
          completionTokens: 500
        }
      ])

      const { result } = await getAdminUsage(
        authFor('usage-admin', { roles: ADMIN_ROLES })
      )

      expect(result.otherApis.map((api) => api.apiId)).toEqual([
        'big-api',
        'small-api'
      ])
    })

    test('reads every team, however many there are', async () => {
      const day = new Date().toISOString().slice(0, 10)
      const bulk = Array.from({ length: 1005 }, (_, index) => ({
        name: `Bulk ${index}`,
        normalisedName: `bulk-${index}`,
        slug: `bulk-${String(index).padStart(4, '0')}`,
        serviceCode: 'ABC'
      }))

      await server.db.collection('teams').insertMany(bulk)
      readUsage.mockResolvedValue([
        {
          day,
          teamSlug: 'bulk-1004',
          deployment: 'bulk-1004-gpt-4o',
          requests: 3,
          promptTokens: 30,
          completionTokens: 3
        }
      ])

      const { result } = await getAdminUsage(
        authFor('usage-admin', { roles: ADMIN_ROLES })
      )
      const last = result.teams.find((team) => team.slug === 'bulk-1004')
      const first = result.teams.find((team) => team.slug === 'bulk-0000')

      expect(result.teams.length).toBeGreaterThanOrEqual(1005)
      expect(last).toMatchObject({ requests: 3, totalTokens: 33 })
      expect(first).toMatchObject({ requests: 0 })
      expect(result.otherApis).toEqual([])
    })

    test('shows the Research tier as an API no team owns even when a team holds its slug', async () => {
      const team = await fixtures.newTeam('usage-admin-clash')
      const day = new Date().toISOString().slice(0, 10)

      // The slug is unique: free it from the team an earlier test gave it to.
      await server.db
        .collection('teams')
        .updateMany({ slug: 'research' }, { $set: { slug: 'research-freed' } })
      await server.db
        .collection('teams')
        .updateOne(
          { _id: new ObjectId(team.teamId) },
          { $set: { slug: 'research' } }
        )
      readUsage.mockResolvedValue([
        {
          day,
          teamSlug: 'research',
          deployment: 'research-gpt-4o',
          requests: 2,
          promptTokens: 20,
          completionTokens: 2
        }
      ])

      const { result } = await getAdminUsage(
        authFor('usage-admin', { roles: ADMIN_ROLES })
      )

      expect(result.otherApis).toEqual([
        expect.objectContaining({ apiId: 'research', requests: 2 })
      ])
      expect(
        result.teams.find((entry) => entry.teamId === team.teamId)
      ).toMatchObject({ requests: 0, totalTokens: 0 })
    })

    test('leaves a cost out when a model has no price, for a team and for an API no team owns', async () => {
      const team = await fixtures.newTeam('usage-admin-mixed')
      const day = new Date().toISOString().slice(0, 10)
      const row = (teamSlug, model, promptTokens) => ({
        day,
        teamSlug,
        deployment: `${teamSlug}-${model}`,
        requests: 1,
        promptTokens,
        completionTokens: 0
      })

      readUsage.mockResolvedValue([
        row(team.slug, 'gpt-4o', 1000),
        row(team.slug, 'unheard-of', 10),
        row('mixed-api', 'gpt-4o', 1000),
        row('mixed-api', 'unheard-of', 10)
      ])

      const { result } = await getAdminUsage(
        authFor('usage-admin', { roles: ADMIN_ROLES })
      )

      expect(
        result.teams.find((entry) => entry.teamId === team.teamId).estimatedCost
      ).toBeNull()
      expect(
        result.otherApis.find((api) => api.apiId === 'mixed-api').estimatedCost
      ).toBeNull()
    })

    test('refuses a bad number of days', async () => {
      const { statusCode, result } = await getAdminUsage(
        authFor('usage-admin', { roles: ADMIN_ROLES }),
        { query: '?days=3' }
      )

      expect(statusCode).toBe(400)
      expect(result.code).toBe('invalid-query')
    })
  })
})
