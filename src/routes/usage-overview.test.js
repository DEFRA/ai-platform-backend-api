import { ObjectId } from 'mongodb'

import { withTestUsers } from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

describe('#usage overview routes', () => {
  let server
  let config
  let reader
  let configuredEnvironments
  let fixtures
  let readUsage
  let readRefusals
  let clearUsageOverviewCache
  let getTeamUsageOverview
  let usageOverviewCacheSize

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')

    ;({ config } = await import('#/config.js'))
    ;({
      usageReaderRegistry: { current: reader }
    } = await import('#/adapters/usage-reader-registry.js'))
    ;({
      clearUsageOverviewCache,
      getTeamUsageOverview,
      usageOverviewCacheSize
    } = await import('#/services/usage-service.js'))
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
    clearUsageOverviewCache()
    readUsage = vi.spyOn(reader, 'readUsage')
    readRefusals = vi.spyOn(reader, 'readRefusals')
  })

  afterEach(() => {
    config.set('teamDeployment.environments', configuredEnvironments)
    vi.restoreAllMocks()
  })

  const today = () => new Date().toISOString().slice(0, 10)

  function getOverview(team, label) {
    return server.inject({
      method: 'GET',
      url: `/v1/teams/${team.slug}/usage`,
      headers: fixtures.as(label)
    })
  }

  describe("a team's overview", () => {
    test('shows a member six months, this month and every environment', async () => {
      const team = await fixtures.newTeam('ov-1-admin')
      await fixtures.addMember(team, 'ov-1-member', 'user')

      const { statusCode, result } = await getOverview(team, 'ov-1-member')

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        teamId: team.teamId,
        source: 'mock',
        costBasis: { estimate: true },
        carbonBasis: { enabled: false },
        budget: null
      })
      expect(result.months).toHaveLength(6)
      expect(result.month.key).toBe(today().slice(0, 7))
      expect(
        result.current.byEnvironment.map((e) => e.environment).sort()
      ).toEqual(['infradev', 'qa'])
      expect(result.current.totals.carbonKg).toBeNull()
    })

    test('asks the reader for this team alone, in each environment', async () => {
      const team = await fixtures.newTeam('ov-2-admin')

      await getOverview(team, 'ov-2-admin')

      const slugs = readUsage.mock.calls.map(([query]) => query.teamSlug)
      const environments = readUsage.mock.calls
        .map(([query]) => query.environment)
        .sort()

      expect(slugs).toEqual([team.slug, team.slug])
      expect(environments).toEqual(['infradev', 'qa'])
      expect(
        readRefusals.mock.calls.every(([query]) => query.teamSlug === team.slug)
      ).toBe(true)
    })

    test('is not found for someone outside the team, and reads nothing', async () => {
      const team = await fixtures.newTeam('ov-3-admin')
      await fixtures.signIn('ov-3-stranger')

      const { statusCode } = await getOverview(team, 'ov-3-stranger')

      expect(statusCode).toBe(404)
      expect(readUsage).not.toHaveBeenCalled()
    })

    test("never reads another team's usage, by id or slug", async () => {
      const mine = await fixtures.newTeam('ov-4-mine')
      const theirs = await fixtures.newTeam('ov-4-theirs')

      const byId = await server.inject({
        method: 'GET',
        url: `/v1/teams/${theirs.teamId}/usage`,
        headers: fixtures.as('ov-4-mine')
      })
      const bySlug = await getOverview(theirs, 'ov-4-mine')

      expect(byId.statusCode).toBe(404)
      expect(bySlug.statusCode).toBe(404)
      expect(readUsage).not.toHaveBeenCalled()
      expect((await getOverview(mine, 'ov-4-mine')).statusCode).toBe(200)
    })

    test('lists an environment with no usage source and shows the others', async () => {
      const team = await fixtures.newTeam('ov-5-admin')
      readUsage.mockImplementation(async ({ environment }) => {
        if (environment === 'qa') {
          throw Object.assign(new Error('none'), {
            code: 'usage-not-available'
          })
        }

        return []
      })
      readRefusals.mockResolvedValue([])

      const { statusCode, result } = await getOverview(team, 'ov-5-admin')

      expect(statusCode).toBe(200)
      expect(result.unavailable).toEqual(['qa'])
      expect(result.current.byEnvironment.map((e) => e.environment)).toEqual([
        'infradev'
      ])
    })

    test('is 404 usage-not-available when no environment has a source', async () => {
      const team = await fixtures.newTeam('ov-6-admin')
      const none = Object.assign(new Error('none'), {
        code: 'usage-not-available'
      })

      readUsage.mockRejectedValue(none)
      readRefusals.mockRejectedValue(none)

      const { statusCode, result } = await getOverview(team, 'ov-6-admin')

      expect(statusCode).toBe(404)
      expect(result.code).toBe('usage-not-available')
    })

    test('answers 502 and shows nothing partial when one environment fails', async () => {
      const team = await fixtures.newTeam('ov-7-admin')

      readUsage.mockImplementation(async ({ environment }) => {
        if (environment === 'qa') {
          throw new Error('workspace law-secret refused')
        }

        return []
      })
      readRefusals.mockResolvedValue([])

      const { statusCode, result } = await getOverview(team, 'ov-7-admin')

      expect(statusCode).toBe(502)
      expect(result.code).toBe('upstream-unavailable')
      expect(JSON.stringify(result)).not.toContain('law-secret')
    })

    test('turns refused calls into something that needs attention', async () => {
      const team = await fixtures.newTeam('ov-8-admin')

      readUsage.mockResolvedValue([])
      readRefusals.mockImplementation(async ({ environment }) =>
        environment === 'qa' ? [{ day: today(), refused: 37 }] : []
      )

      const { result } = await getOverview(team, 'ov-8-admin')

      expect(result.attention).toEqual([
        { kind: 'calls-refused', environment: 'qa', count: 37, days: 7 }
      ])
    })

    test('reads once for two asks within a minute', async () => {
      const team = await fixtures.newTeam('ov-9-admin')

      await getOverview(team, 'ov-9-admin')
      await getOverview(team, 'ov-9-admin')

      expect(readUsage).toHaveBeenCalledTimes(2)
    })

    test('adds carbon only when the flag is on', async () => {
      const team = await fixtures.newTeam('ov-10-admin')
      const day = today()

      readUsage.mockResolvedValue([
        {
          day,
          teamSlug: team.slug,
          deployment: `${team.slug}-gpt-4o`,
          requests: 1,
          promptTokens: 1_000_000,
          completionTokens: 0
        }
      ])
      readRefusals.mockResolvedValue([])
      config.set('usage.carbonEnabled', true)

      try {
        const { result } = await getOverview(team, 'ov-10-admin')

        expect(result.carbonBasis.enabled).toBe(true)
        expect(result.current.totals.carbonKg).toBeGreaterThan(0)
      } finally {
        config.set('usage.carbonEnabled', false)
      }
    })

    test('needs a signed-in person', async () => {
      const team = await fixtures.newTeam('ov-11-admin')

      const { statusCode } = await server.inject({
        method: 'GET',
        url: `/v1/teams/${team.slug}/usage`
      })

      expect(statusCode).toBe(401)
    })

    test('releases an earlier day’s overview when the day rolls over', async () => {
      const team = await fixtures.newTeam('ov-12-admin')
      const actor = { userId: fixtures.as('ov-12-admin')['x-user-id'] }
      const at = (day) => () => new Date(Date.UTC(2026, 10, day, 12))
      const ask = (day) =>
        getTeamUsageOverview(
          server.db,
          { teamId: team.teamId, actor },
          { reader, now: at(day) }
        )

      await ask(1)
      await ask(1)
      expect(usageOverviewCacheSize()).toBe(1)

      await ask(2)
      expect(usageOverviewCacheSize()).toBe(1)
    })
  })

  describe("a person's summary for Home", () => {
    test('lists each team the person belongs to, and only those', async () => {
      const mine = await fixtures.newTeam('hm-1-admin')
      await fixtures.newTeam('hm-1-other')

      const { statusCode, result } = await server.inject({
        method: 'GET',
        url: '/v1/users/me/usage',
        headers: fixtures.as('hm-1-admin')
      })

      expect(statusCode).toBe(200)
      expect(result.items.map((item) => item.slug)).toEqual([mine.slug])
      expect(result.items[0]).toMatchObject({
        available: true,
        teamId: mine.teamId
      })
      expect(result.items[0].totals).toHaveProperty('cost')
      expect(result.items[0].forecast).toHaveProperty('tokens')
    })

    test('lists a team whose usage cannot be read, with the reason, instead of leaving it out', async () => {
      const team = await fixtures.newTeam('hm-2-admin')
      const none = Object.assign(new Error('none'), {
        code: 'usage-not-available'
      })

      readUsage.mockRejectedValue(none)
      readRefusals.mockRejectedValue(none)

      const { result } = await server.inject({
        method: 'GET',
        url: '/v1/users/me/usage',
        headers: fixtures.as('hm-2-admin')
      })

      expect(result.items).toEqual([
        expect.objectContaining({
          slug: team.slug,
          available: false,
          reason: 'usage-not-available'
        })
      ])
    })

    test('has no teams for a person with none', async () => {
      await fixtures.signIn('hm-3-nobody')

      const { result } = await server.inject({
        method: 'GET',
        url: '/v1/users/me/usage',
        headers: fixtures.as('hm-3-nobody')
      })

      expect(result.items).toEqual([])
    })
  })

  describe("a personal key's usage", () => {
    async function insertKey(label, overrides = {}) {
      await fixtures.signIn(label)

      const user = await server.db
        .collection('users')
        .findOne({ email: `${label}@defra.gov.uk` })
      const { insertedId } = await server.db
        .collection('credentials')
        .insertOne({
          userId: user._id.toString(),
          tier: 'research',
          environment: 'infradev',
          status: 'active',
          externalGatewaySubscriptionId: `sub-${label}`,
          expiresAt: '2026-12-01T00:00:00.000Z',
          renewalCount: 1,
          ...overrides
        })

      return insertedId.toString()
    }

    function getKey(id, label, query = '') {
      return server.inject({
        method: 'GET',
        url: `/v1/credentials/${id}/usage${query}`,
        headers: fixtures.as(label)
      })
    }

    test("shows the owner the key's usage, asked for by its subscription alone", async () => {
      const id = await insertKey('key-1')

      const { statusCode, result } = await getKey(id, 'key-1')

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        credentialId: id,
        environment: 'infradev',
        key: {
          expiresAt: '2026-12-01T00:00:00.000Z',
          renewalsUsed: 1,
          renewalCap: 3,
          validDays: 7
        }
      })
      expect(result.byDay).toHaveLength(30)
      expect(readUsage.mock.calls[0][0]).toMatchObject({
        environment: 'infradev',
        subscriptionId: 'sub-key-1'
      })
      expect(readUsage.mock.calls[0][0].teamSlug).toBeUndefined()
    })

    test('takes 7 or 90 days, and refuses any other number', async () => {
      const id = await insertKey('key-2')

      expect((await getKey(id, 'key-2', '?days=7')).result.byDay).toHaveLength(
        7
      )
      expect((await getKey(id, 'key-2', '?days=5')).statusCode).toBe(400)
    })

    test("is not found for someone else's key, audited, and reads nothing", async () => {
      const id = await insertKey('key-3')
      await fixtures.signIn('key-3-other')

      const { statusCode } = await getKey(id, 'key-3-other')

      expect(statusCode).toBe(404)
      expect(readUsage).not.toHaveBeenCalled()
      expect(
        await server.db
          .collection('auditEvents')
          .countDocuments({ action: 'access.denied', resourceId: id })
      ).toBeGreaterThan(0)
    })

    test('is not found for an id that is no key, and for a key that is not a personal one', async () => {
      const team = await insertKey('key-4', { tier: 'team' })

      expect(
        (await getKey(new ObjectId().toString(), 'key-4')).statusCode
      ).toBe(404)
      expect((await getKey(team, 'key-4')).statusCode).toBe(404)
      expect(readUsage).not.toHaveBeenCalled()
    })

    test.each(['pending', 'failed'])(
      'is 404 usage-not-available for a %s key with no gateway subscription, and reads nothing',
      async (status) => {
        const id = await insertKey(`key-5-${status}`, {
          status,
          externalGatewaySubscriptionId: null
        })

        const { statusCode, result } = await getKey(id, `key-5-${status}`)

        expect(statusCode).toBe(404)
        expect(result.code).toBe('usage-not-available')
        expect(readUsage).not.toHaveBeenCalled()
      }
    )
  })
})
