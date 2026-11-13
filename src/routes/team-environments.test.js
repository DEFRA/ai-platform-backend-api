import { Collection } from 'mongodb'

import { withTestUsers } from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

const MODEL = {
  slug: 'env-test-model',
  displayName: 'Env Test Model',
  tiers: ['research', 'team'],
  environments: ['sandbox', 'infradev', 'qa'],
  eligible: true,
  regions: ['uksouth'],
  skus: [{ name: 'DataZoneStandard', tiers: ['team'], regions: ['uksouth'] }],
  capacityPolicy: {
    min: 1,
    max: 100,
    default: 10,
    environments: { infradev: { min: 1, max: 5, default: 1 } }
  },
  limitsDefault: { requestsPerMinute: 60, tokensPerDay: 100000 }
}
const LIMITS = { tokensPerMinute: 1000, requestsPerMinute: 60 }

function teamFile(slug, environment, limits = LIMITS) {
  return {
    schemaVersion: 1,
    revision: 3,
    environment,
    status: 'active',
    team: { slug, serviceCode: 'ABC' },
    deployments: [
      {
        slug: MODEL.slug,
        sku: 'DataZoneStandard',
        capacity: 1,
        status: 'active'
      }
    ],
    gateway: {
      credentialType: 'oauth',
      allowedDeployments: [MODEL.slug],
      limits
    },
    oauth: { federations: [], externalClients: [], secretsAllowed: true }
  }
}

describe('#team-environments routes', () => {
  let server
  let config
  let mockTeamFileReader
  let configuredEnvironments
  let fixtures

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')
    const { invalidateModelsCache } =
      await import('#/services/models-service.js')

    ;({ config } = await import('#/config.js'))
    ;({ mockTeamFileReader } =
      await import('#/adapters/mock-team-file-reader.js'))
    server = await createServer()
    await server.initialize()
    withTestUsers(server)
    fixtures = createTeamFixtures(server)
    configuredEnvironments = config.get('teamDeployment.environments')
    await server.db.collection('models').insertOne({ ...MODEL })
    invalidateModelsCache()
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  beforeEach(() => {
    config.set('teamDeployment.environments', ['infradev', 'qa'])
  })

  afterEach(() => {
    config.set('teamDeployment.environments', configuredEnvironments)
    vi.restoreAllMocks()
  })

  // The tenant files `main` holds for a team, by environment.
  function filesOf(team, byEnvironment) {
    vi.spyOn(mockTeamFileReader, 'getCurrentDocument').mockImplementation(
      async ({ path }) => {
        const [, environment, slug] =
          /^environments\/([^/]+)\/(.+)\.json$/.exec(path)

        return {
          document:
            slug === team.slug ? (byEnvironment[environment] ?? null) : null
        }
      }
    )
  }

  // A team's deployment entries in an environment, as the projection keeps them.
  async function deploymentsIn(team, environment, entries) {
    await server.db.collection('teamDeployments').insertOne({
      teamId: team.teamId,
      environment,
      gateway: { credentialType: 'oauth', allowedDeployments: [], limits: {} },
      deployments: entries.map((entry, index) => ({
        id: `entry-${environment}-${index}`,
        modelSlug: MODEL.slug,
        statusTimes: {},
        operationId: null,
        requestedBy: 'user-1',
        idempotencyKey: 'k',
        createdAt: '2026-11-12T10:00:00.000Z',
        activatedAt: null,
        failureReason: null,
        ...entry
      }))
    })
  }

  // A team's applications in an environment, as the projection keeps them
  // (the document may already exist from a model request).
  async function federationsIn(team, environment, entries) {
    await server.db.collection('teamDeployments').updateOne(
      { teamId: team.teamId, environment },
      {
        $set: {
          federations: entries.map((entry, index) => ({
            id: `fed-${environment}-${index}`,
            host: 'cdp',
            statusTimes: {},
            operationId: null,
            failureReason: null,
            ...entry
          }))
        }
      },
      { upsert: true }
    )
  }

  function getAll(team, label) {
    return server.inject({
      method: 'GET',
      url: `/v1/teams/${team.slug}/environments`,
      headers: fixtures.as(label)
    })
  }

  function getOne(team, environment, label) {
    return server.inject({
      method: 'GET',
      url: `/v1/teams/${team.slug}/environments/${environment}`,
      headers: fixtures.as(label)
    })
  }

  describe('GET /v1/teams/{teamId}/environments', () => {
    test('lists each configured environment in order, set up or not, with the team’s models, limits and latest change', async () => {
      const team = await fixtures.newTeam('env-list-1')

      filesOf(team, { infradev: teamFile(team.slug, 'infradev') })
      await deploymentsIn(team, 'infradev', [
        { status: 'active' },
        { status: 'requested' },
        { status: 'removed' }
      ])
      await fixtures.seedOperation(team, { minute: 1 })

      const latest = await fixtures.seedOperation(team, {
        minute: 2,
        requestedBy: 'env-list-1'
      })
      const { statusCode, result } = await getAll(team, 'env-list-1')

      expect(statusCode).toBe(200)
      expect(result.team).toEqual({
        id: team.teamId,
        slug: team.slug,
        name: expect.stringMatching(/^Fixture env-list-1/)
      })
      expect(result.environments.map(({ environment }) => environment)).toEqual(
        ['infradev', 'qa']
      )

      const [infradev, qa] = result.environments

      expect(infradev).toMatchObject({
        environment: 'infradev',
        setUp: true,
        paused: false,
        limits: LIMITS,
        applications: { used: 0, limit: 20 },
        inProgress: false,
        latestOperation: {
          id: latest._id,
          requestedBy: { name: 'Name of env-list-1' }
        }
      })
      // Every model that is not removed, the ready ones counted.
      expect(infradev.models.count).toBe(1)
      expect(infradev.models.items).toEqual([
        { id: 'entry-infradev-0', modelSlug: MODEL.slug, status: 'active' },
        { id: 'entry-infradev-1', modelSlug: MODEL.slug, status: 'requested' }
      ])
      expect(qa).toMatchObject({
        environment: 'qa',
        setUp: false,
        paused: false,
        models: { count: 0, items: [] },
        limits: null,
        latestOperation: null,
        inProgress: false
      })
    })

    test('shows a change in progress and a paused environment', async () => {
      const team = await fixtures.newTeam('env-list-2')

      filesOf(team, { infradev: teamFile(team.slug, 'infradev') })
      await fixtures.seedOperation(team, {
        minute: 1,
        state: 'deploying',
        slot: 'active'
      })
      await server.db
        .collection('environmentControls')
        .updateOne(
          { _id: 'infradev' },
          { $set: { paused: true } },
          { upsert: true }
        )

      const { result } = await getAll(team, 'env-list-2')

      await server.db.collection('environmentControls').deleteMany({})

      expect(result.environments[0]).toMatchObject({
        paused: true,
        inProgress: true,
        latestOperation: { state: 'deploying', open: true }
      })
      expect(result.environments[1]).toMatchObject({
        paused: false,
        inProgress: false
      })
    })

    test('shows the same to a Member as to an Admin', async () => {
      const team = await fixtures.newTeam('env-list-3')

      await fixtures.addMember(team, 'env-list-3-member')
      filesOf(team, { infradev: teamFile(team.slug, 'infradev') })

      const asAdmin = await getAll(team, 'env-list-3')
      const asMember = await getAll(team, 'env-list-3-member')

      expect(asMember.statusCode).toBe(200)
      expect(asMember.result).toEqual(asAdmin.result)
    })

    test('is not found for someone outside the team, audited, and reads nothing for them', async () => {
      const team = await fixtures.newTeam('env-list-4')

      await fixtures.signIn('env-list-4-stranger')
      filesOf(team, {})

      const { statusCode, result } = await getAll(team, 'env-list-4-stranger')

      expect(statusCode).toBe(404)
      expect(JSON.stringify(result)).not.toMatch(/infradev/)
      expect(mockTeamFileReader.getCurrentDocument).not.toHaveBeenCalled()
      expect(
        await server.db.collection('auditEvents').countDocuments({
          action: 'access.denied',
          resourceId: team.teamId,
          code: 'not-a-member'
        })
      ).toBeGreaterThan(0)
    })

    test('is not found for a team that does not exist', async () => {
      await fixtures.signIn('env-list-5')

      const { statusCode } = await server.inject({
        method: 'GET',
        url: '/v1/teams/no-such-team/environments',
        headers: fixtures.as('env-list-5')
      })

      expect(statusCode).toBe(404)
    })

    test('is refused as upstream-unavailable when a team file cannot be read, not shown as not set up', async () => {
      const team = await fixtures.newTeam('env-list-6')

      vi.spyOn(mockTeamFileReader, 'getCurrentDocument').mockRejectedValue(
        new Error('GitHub is down')
      )

      const { statusCode, result } = await getAll(team, 'env-list-6')

      expect(statusCode).toBe(502)
      expect(result.code).toBe('upstream-unavailable')
    })

    test('shows a file that holds no limits of its own as null limits, not as not set up', async () => {
      const team = await fixtures.newTeam('env-list-8')
      const { gateway, ...rest } = teamFile(team.slug, 'infradev')

      filesOf(team, {
        infradev: {
          ...rest,
          gateway: { credentialType: gateway.credentialType }
        }
      })

      const { result } = await getAll(team, 'env-list-8')

      expect(result.environments[0]).toMatchObject({
        setUp: true,
        limits: { tokensPerMinute: null, requestsPerMinute: null }
      })
    })

    test('counts the applications that hold a place in the registration, the team file’s and the asked-for, not the failed or removed', async () => {
      const team = await fixtures.newTeam('env-list-9')
      const file = teamFile(team.slug, 'infradev')

      file.oauth.federations = [{ name: 'one', host: 'cdp', service: 'one' }]
      filesOf(team, { infradev: file })
      await federationsIn(team, 'infradev', [
        { name: 'one', service: 'one', status: 'ready' },
        { name: 'two', service: 'two', status: 'ready' },
        { name: 'three', service: 'three', status: 'setting-up' },
        { name: 'four', service: 'four', status: 'failed' },
        { name: 'five', service: 'five', status: 'removed' },
        { name: 'six', service: 'six', status: 'removing' }
      ])

      const { result } = await getAll(team, 'env-list-9')

      // one (in the file and recorded, once), two, three and six.
      expect(result.environments[0].applications).toEqual({
        used: 4,
        limit: 20
      })
      expect(result.environments[1].applications).toEqual({
        used: 0,
        limit: 20
      })
    })

    test('reads only this team’s files and every database read carries the team', async () => {
      const team = await fixtures.newTeam('env-list-7')
      const other = await fixtures.newTeam('env-list-7-other')

      filesOf(team, { infradev: teamFile(team.slug, 'infradev') })
      await deploymentsIn(other, 'infradev', [{ status: 'active' }])
      await fixtures.seedOperation(other, { minute: 1 })

      const reads = []

      for (const method of ['find', 'findOne', 'countDocuments', 'aggregate']) {
        const original = Collection.prototype[method]

        vi.spyOn(Collection.prototype, method).mockImplementation(function (
          ...args
        ) {
          reads.push({ collection: this.collectionName, filter: args[0] })

          return original.apply(this, args)
        })
      }

      const { result } = await getAll(team, 'env-list-7')

      expect(result.environments[0].models.items).toEqual([])
      expect(result.environments[0].latestOperation).toBeNull()
      expect(
        mockTeamFileReader.getCurrentDocument.mock.calls.map(
          ([{ path }]) => path
        )
      ).toEqual([
        `environments/infradev/${team.slug}.json`,
        `environments/qa/${team.slug}.json`
      ])

      const teamData = reads.filter(({ collection }) =>
        ['teamDeployments', 'operations', 'teamMembers'].includes(collection)
      )

      expect(teamData.length).toBeGreaterThan(0)
      expect(
        teamData.every(({ filter }) => filter.teamId === team.teamId)
      ).toBe(true)
    })
  })

  describe('GET /v1/teams/{teamId}/environments/{environment}', () => {
    test('shows one environment in full: models as the deployments read gives them, the bounds and pending limits', async () => {
      const team = await fixtures.newTeam('env-one-1')

      filesOf(team, { infradev: teamFile(team.slug, 'infradev') })
      await deploymentsIn(team, 'infradev', [
        { status: 'active', activatedAt: '2026-11-12T10:05:00.000Z' },
        { status: 'removed' }
      ])
      await fixtures.seedOperation(team, {
        minute: 3,
        state: 'deploying',
        slot: 'active',
        items: [
          {
            kind: 'limits',
            change: 'set',
            limits: { tokensPerMinute: 3000, requestsPerMinute: 40 }
          }
        ]
      })

      const { statusCode, result } = await getOne(team, 'infradev', 'env-one-1')

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        environment: 'infradev',
        setUp: true,
        limits: LIMITS,
        // One model with a maximum of 5 capacity units in Infradev.
        limitBounds: {
          tokensPerMinute: { min: 1, max: 5000 },
          requestsPerMinute: { min: 1, max: 60 }
        },
        pendingLimits: { tokensPerMinute: 3000, requestsPerMinute: 40 },
        inProgress: true
      })
      expect(result.models).toHaveLength(1)
      expect(result.models[0]).toMatchObject({
        _id: 'entry-infradev-0',
        environment: 'infradev',
        modelSlug: MODEL.slug,
        status: 'active',
        progressSteps: expect.any(Array)
      })
      expect(result.models[0].progressSteps[0].label).toBeTruthy()
    })

    test('lists the applications not removed, and the connection details flagged a placeholder', async () => {
      const team = await fixtures.newTeam('env-one-10')

      filesOf(team, { infradev: teamFile(team.slug, 'infradev') })
      await federationsIn(team, 'infradev', [
        { name: 'two', service: 'two', status: 'ready' },
        {
          name: 'data-app',
          host: 'azure',
          principalId: '6f504113-6b64-43f2-ade9-242e05780007',
          status: 'failed',
          failureReason: 'Checks failed'
        },
        { name: 'five', service: 'five', status: 'removed' }
      ])

      const { result } = await getOne(team, 'infradev', 'env-one-10')

      expect(result.applications).toEqual({
        used: 1,
        limit: 20,
        items: [
          expect.objectContaining({
            name: 'two',
            host: 'cdp',
            service: 'two',
            status: 'ready'
          }),
          expect.objectContaining({
            name: 'data-app',
            host: 'azure',
            principalId: '6f504113-6b64-43f2-ade9-242e05780007',
            status: 'failed',
            failureReason: 'Checks failed'
          })
        ]
      })
      expect(result.connection).toMatchObject({
        placeholder: true,
        gatewayUrl: expect.stringContaining(team.slug),
        clientId: expect.any(String),
        scope: expect.stringContaining('/.default')
      })
    })

    test('has no connection details for an environment the team has not set up', async () => {
      const team = await fixtures.newTeam('env-one-11')

      filesOf(team, {})

      const { result } = await getOne(team, 'qa', 'env-one-11')

      expect(result.connection).toBeNull()
      expect(result.applications).toEqual({ used: 0, limit: 20, items: [] })
    })

    test('reads only that environment’s file', async () => {
      const team = await fixtures.newTeam('env-one-2')

      filesOf(team, { infradev: teamFile(team.slug, 'infradev') })

      await getOne(team, 'infradev', 'env-one-2')

      expect(
        mockTeamFileReader.getCurrentDocument.mock.calls.map(
          ([{ path }]) => path
        )
      ).toEqual([`environments/infradev/${team.slug}.json`])
    })

    test('shows an environment the team has not set up, with no limits and no bounds', async () => {
      const team = await fixtures.newTeam('env-one-3')

      filesOf(team, {})

      const { statusCode, result } = await getOne(team, 'qa', 'env-one-3')

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        environment: 'qa',
        setUp: false,
        limits: null,
        limitBounds: null,
        pendingLimits: null,
        models: []
      })
    })

    test('has no bounds when the catalogue holds none of the team’s models', async () => {
      const team = await fixtures.newTeam('env-one-4')

      filesOf(team, {
        infradev: {
          ...teamFile(team.slug, 'infradev'),
          deployments: [{ slug: 'not-in-catalogue', status: 'active' }]
        }
      })

      const { result } = await getOne(team, 'infradev', 'env-one-4')

      expect(result.setUp).toBe(true)
      expect(result.limitBounds).toBeNull()
    })

    test('has no pending limits once the limits change has ended', async () => {
      const team = await fixtures.newTeam('env-one-5')

      filesOf(team, { infradev: teamFile(team.slug, 'infradev') })
      await fixtures.seedOperation(team, {
        minute: 3,
        items: [
          {
            kind: 'limits',
            change: 'set',
            limits: { tokensPerMinute: 3000, requestsPerMinute: 40 }
          }
        ]
      })

      const { result } = await getOne(team, 'infradev', 'env-one-5')

      expect(result.pendingLimits).toBeNull()
      expect(result.inProgress).toBe(false)
    })

    test('is not found, with a code, for an environment this instance does not offer', async () => {
      const team = await fixtures.newTeam('env-one-6')

      const { statusCode, result } = await getOne(team, 'prod', 'env-one-6')

      expect(statusCode).toBe(404)
      expect(result.code).toBe('environment-not-available')
    })

    test('is a bad request for something that is not an environment name', async () => {
      const team = await fixtures.newTeam('env-one-7')

      const { statusCode } = await getOne(team, 'Not%20Real', 'env-one-7')

      expect(statusCode).toBe(400)
    })

    test('is not found for someone outside the team, whatever the environment, and audited', async () => {
      const team = await fixtures.newTeam('env-one-8')

      await fixtures.signIn('env-one-8-stranger')

      const real = await getOne(team, 'infradev', 'env-one-8-stranger')
      const unavailable = await getOne(team, 'prod', 'env-one-8-stranger')

      expect(real.statusCode).toBe(404)
      expect(unavailable.statusCode).toBe(404)
      expect(unavailable.result.code).not.toBe('environment-not-available')
      expect(
        await server.db
          .collection('auditEvents')
          .countDocuments({ action: 'access.denied', resourceId: team.teamId })
      ).toBeGreaterThanOrEqual(2)
    })

    test('is refused as upstream-unavailable when the team file cannot be read', async () => {
      const team = await fixtures.newTeam('env-one-9')

      vi.spyOn(mockTeamFileReader, 'getCurrentDocument').mockRejectedValue(
        new Error('GitHub is down')
      )

      const { statusCode, result } = await getOne(team, 'infradev', 'env-one-9')

      expect(statusCode).toBe(502)
      expect(result.code).toBe('upstream-unavailable')
    })
  })
})
