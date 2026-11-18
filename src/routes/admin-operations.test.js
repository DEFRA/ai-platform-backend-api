import {
  appAuth,
  authFor,
  withTestUsers
} from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

const ADMIN = 'admin-operations-admin'
const ENVIRONMENT = 'sandbox'
const LIMITS = {
  kind: 'limits',
  change: 'set',
  limits: { tokensPerMinute: 2000, requestsPerMinute: 120 }
}
const FEDERATION = { kind: 'federation', change: 'add', entryId: 'f1' }

let settleEvents

describe('#admin operations: retry and reconcile', () => {
  let server
  let fixtures

  beforeAll(async () => {
    vi.stubEnv('TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS', '30')

    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    withTestUsers(server)
    fixtures = createTeamFixtures(server)
    settleEvents = () => server.app.operations.transport.worker.idle()
  })

  afterAll(async () => {
    await settleEvents()
    await server.stop({ timeout: 0 })
    vi.unstubAllEnvs()
  })

  afterEach(async () => {
    await settleEvents()
    vi.restoreAllMocks()
  })

  const asAdmin = () =>
    authFor(ADMIN, { roles: ['research-user', 'platform-admin'] })

  function call(kind, id, headers = asAdmin()) {
    return server.inject({
      method: 'POST',
      url: `/v1/admin/operations/${id}/${kind}`,
      headers
    })
  }

  // A team's operation in the Sandbox, seeded in the given state.
  async function seeded(label, { items, ...overrides }) {
    const team = await fixtures.newTeam(label)
    const operation = await fixtures.seedOperation(team, {
      minute: 1,
      environment: ENVIRONMENT,
      items,
      ...overrides
    })

    return { team, operation }
  }

  const auditOf = (action, resourceId) =>
    server.db.collection('auditEvents').find({ action, resourceId }).toArray()

  const storedOf = (id) =>
    server.db.collection('operations').findOne({ _id: id })

  test('retry publishes a fresh apply for a limits-only change that failed, and audits the state change with team and environment', async () => {
    const { team, operation } = await seeded('admin-ops-1', {
      items: [LIMITS],
      state: 'deploy-failed'
    })

    const { statusCode, result } = await call('retry', operation._id)

    expect(statusCode).toBe(202)
    expect(result.operation).toEqual({ id: operation._id, state: 'deploying' })
    expect(await auditOf('admin.operation.retry', operation._id)).toEqual([
      expect.objectContaining({
        role: 'platform-admin',
        teamId: team.teamId,
        environment: ENVIRONMENT,
        outcome: 'success',
        reason: 'deploy-failed -> deploying'
      })
    ])
    expect((await storedOf(operation._id)).attempt).toBe(2)
  })

  test('retry resumes a federation-only change that timed out', async () => {
    const { operation } = await seeded('admin-ops-2', {
      items: [FEDERATION],
      state: 'timed-out',
      leftState: 'deploying'
    })

    const { statusCode, result } = await call('retry', operation._id)

    expect(statusCode).toBe(202)
    expect(result.operation).toEqual({ id: operation._id, state: 'deploying' })
  })

  test('retry refuses an operation that is not retryable with 409 operation-not-retryable, changing and publishing nothing', async () => {
    const { operation } = await seeded('admin-ops-3', {
      items: [LIMITS],
      state: 'active'
    })

    const { statusCode, result } = await call('retry', operation._id)

    expect(statusCode).toBe(409)
    expect(result.code).toBe('operation-not-retryable')
    expect(await storedOf(operation._id)).toMatchObject({
      state: 'active',
      outbox: []
    })
    expect(await auditOf('admin.operation.retry', operation._id)).toEqual([])
  })

  test('reconcile publishes a reconcile for an operation in any state and audits it', async () => {
    const { team, operation } = await seeded('admin-ops-4', {
      items: [FEDERATION],
      state: 'deploying'
    })

    const { statusCode, result } = await call('reconcile', operation._id)

    expect(statusCode).toBe(202)
    expect(result.operation.id).toBe(operation._id)
    expect(
      (await storedOf(operation._id)).outbox.map(({ type }) => type)
    ).toContain('reconcile')
    expect(await auditOf('admin.operation.reconcile', operation._id)).toEqual([
      expect.objectContaining({
        teamId: team.teamId,
        environment: ENVIRONMENT,
        outcome: 'success'
      })
    ])
  })

  test.each(['retry', 'reconcile'])(
    '%s answers 404 operation-not-found for an operation that does not exist',
    async (kind) => {
      const { statusCode, result } = await call(kind, 'no-such-operation')

      expect(statusCode).toBe(404)
      expect(result.code).toBe('operation-not-found')
    }
  )

  test.each(['retry', 'reconcile'])(
    '%s refuses a person who is not a Platform Admin with 403 and the app-only token with 401, changing nothing',
    async (kind) => {
      const { team, operation } = await seeded(`admin-ops-5-${kind}`, {
        items: [LIMITS],
        state: 'deploy-failed'
      })

      const person = await call(kind, operation._id, fixtures.as(team.admin))
      const app = await call(kind, operation._id, appAuth())

      expect(person.statusCode).toBe(403)
      expect(person.result.code).toBe('platform-admin-required')
      expect(app.statusCode).toBe(401)
      expect(await storedOf(operation._id)).toMatchObject({
        state: 'deploy-failed',
        outbox: []
      })
    }
  )

  test.each(['retry', 'reconcile'])(
    '%s answers 502 upstream-unavailable and audits a failure when the command cannot be dispatched',
    async (kind) => {
      const { team, operation } = await seeded(`admin-ops-6-${kind}`, {
        items: [LIMITS],
        state: 'deploy-failed'
      })

      vi.spyOn(server.app.operations.operations, kind).mockRejectedValue(
        new Error('the database is down')
      )

      const { statusCode, result } = await call(kind, operation._id)

      expect(statusCode).toBe(502)
      expect(result.code).toBe('upstream-unavailable')
      expect(await auditOf(`admin.operation.${kind}`, operation._id)).toEqual([
        expect.objectContaining({
          teamId: team.teamId,
          environment: ENVIRONMENT,
          outcome: 'failure',
          code: 'upstream-unavailable'
        })
      ])
    }
  )

  test('does not reach an operation that is not a change to a team file', async () => {
    const { operation } = await seeded('admin-ops-7', {
      items: [LIMITS],
      state: 'deploy-failed',
      type: 'pin.write'
    })

    const { statusCode, result } = await call('retry', operation._id)

    expect(statusCode).toBe(404)
    expect(result.code).toBe('operation-not-found')
  })

  describe('the deployment read', () => {
    async function readOf(team) {
      const { result } = await server.inject({
        method: 'GET',
        url: `/v1/admin/team-deployments/${team.teamId}/${ENVIRONMENT}`,
        headers: asAdmin()
      })

      return result
    }

    async function withFederations(team, federations) {
      await server.db.collection('teamDeployments').insertOne({
        teamId: team.teamId,
        environment: ENVIRONMENT,
        deployments: [],
        federations
      })
    }

    const federationOf = (id, status, operationId) => ({
      id,
      name: id,
      host: 'cdp',
      service: `${id}-api`,
      status,
      operationId
    })

    test('gives each federation its retryable by its operation', async () => {
      const failed = await seeded('admin-ops-8', {
        items: [FEDERATION],
        state: 'deploy-failed'
      })
      const active = await fixtures.seedOperation(failed.team, {
        minute: 2,
        environment: ENVIRONMENT,
        items: [FEDERATION],
        state: 'active'
      })

      await withFederations(failed.team, [
        federationOf('fed-failed', 'failed', failed.operation._id),
        federationOf('fed-ready', 'ready', active._id),
        federationOf('fed-none', 'setting-up', null)
      ])

      const { federations } = await readOf(failed.team)

      expect(federations.map(({ id, retryable }) => [id, retryable])).toEqual([
        ['fed-failed', true],
        ['fed-ready', false],
        ['fed-none', false]
      ])
    })

    test.each([
      ['has failed', { state: 'deploy-failed' }, true],
      ['timed out', { state: 'timed-out', leftState: 'deploying' }, true],
      [
        'is held',
        { state: 'queued', held: { since: '2026-11-12T10:00:00.000Z' } },
        true
      ],
      ['was refused by its checks', { state: 'checks-failed' }, false]
    ])(
      'returns the latest limits-only change while it %s',
      async (_what, overrides, retryable) => {
        const { team, operation } = await seeded(
          `admin-ops-9-${_what.replaceAll(' ', '-')}`,
          { items: [LIMITS], ...overrides }
        )

        await withFederations(team, [])

        const { limitsOperation } = await readOf(team)

        expect(limitsOperation).toMatchObject({
          id: operation._id,
          state: overrides.state,
          retryable
        })
      }
    )

    test('leaves the limits change out once it is settled, when a newer one settled it, and when the change also holds a model', async () => {
      const settled = await seeded('admin-ops-10', {
        items: [LIMITS],
        state: 'active'
      })
      const superseded = await seeded('admin-ops-11', {
        items: [LIMITS],
        state: 'deploy-failed'
      })
      const mixed = await seeded('admin-ops-12', {
        items: [LIMITS, { entryId: 'e1', modelSlug: 'gpt-4o', change: 'add' }],
        state: 'deploy-failed'
      })

      await fixtures.seedOperation(superseded.team, {
        minute: 5,
        environment: ENVIRONMENT,
        items: [LIMITS],
        state: 'active'
      })

      for (const { team } of [settled, superseded, mixed]) {
        await withFederations(team, [])
        expect(await readOf(team)).not.toHaveProperty('limitsOperation')
      }
    })
  })
})
