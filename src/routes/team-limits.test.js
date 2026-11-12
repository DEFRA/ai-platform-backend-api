import { randomUUID } from 'node:crypto'

import { withTestUsers } from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

// gpt-4o in the seed lets a team hold up to 100 capacity units, which is
// 100,000 tokens a minute and, at 6 a minute per 1,000, 600 requests a minute
// (the catalogue's default of 60 is lower).
const MAX_TOKENS = 100000
const MAX_REQUESTS = 600
const STARTING_LIMITS = { tokensPerMinute: 1000, requestsPerMinute: 60 }
const CHANGED = { tokensPerMinute: 2000, requestsPerMinute: 120 }

let settleEvents

describe('#team-limits routes', () => {
  let server
  let fixtures
  let mockTeamFileReader

  beforeAll(async () => {
    // A short mock stage so a change can run to its end within a test.
    vi.stubEnv('TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS', '30')

    const { createServer } = await import('#/server.js')

    ;({ mockTeamFileReader } =
      await import('#/adapters/mock-team-file-reader.js'))
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

  // A team with gpt-4o deployed in the Sandbox: its file is on `main` (as
  // the mock holds it) with the starting limits.
  async function deployedTeam(label) {
    const team = await fixtures.newTeam(label)
    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${team.teamId}/deployments`,
      headers: fixtures.asWithKey(label),
      payload: { modelSlugs: ['gpt-4o'], environment: 'sandbox' }
    })

    expect(statusCode).toBe(201)
    await settleEvents()

    return team
  }

  function put(
    team,
    label,
    payload,
    { key = randomUUID(), environment = 'sandbox' } = {}
  ) {
    return server.inject({
      method: 'PUT',
      url: `/v1/teams/${team.slug}/environments/${environment}/limits`,
      headers: { ...fixtures.as(label), 'idempotency-key': key },
      payload
    })
  }

  function limitOperations(team) {
    return server.db
      .collection('operations')
      .find({ teamId: team.teamId, 'items.kind': 'limits' })
      .toArray()
  }

  function auditOf(team, filter) {
    return server.db
      .collection('auditEvents')
      .find({ resourceId: team.teamId, ...filter })
      .toArray()
  }

  describe('an Admin changing the limits within bounds', () => {
    test('accepts it as one operation, and the file then holds the new limits and keeps everything else', async () => {
      const team = await deployedTeam('limits-ok-1')
      const [before] = await server.db
        .collection('operations')
        .find({ teamId: team.teamId })
        .toArray()
      const firstFile = JSON.parse(before.document)

      expect(firstFile.gateway.limits).toEqual(STARTING_LIMITS)

      const { statusCode, headers, result } = await put(
        team,
        'limits-ok-1',
        CHANGED
      )

      expect(statusCode).toBe(202)
      expect(headers.location).toBe(
        `/v1/teams/${team.slug}/operations/${result.operation.id}`
      )
      expect(result.operation).toMatchObject({
        environment: 'sandbox',
        kind: 'limits',
        state: 'requested',
        open: true,
        changes: [{ kind: 'limits', change: 'set', limits: CHANGED }],
        requestedBy: { name: 'Name of limits-ok-1' }
      })

      await settleEvents()

      const [change] = await limitOperations(team)
      const file = JSON.parse(change.document)

      expect(change).toMatchObject({
        type: 'team-file.write',
        state: 'active',
        items: [{ kind: 'limits', change: 'set', limits: CHANGED }]
      })
      // The second revision of the file: only the limits moved.
      expect(file.revision).toBe(2)
      expect(file.gateway).toEqual({
        ...firstFile.gateway,
        limits: CHANGED
      })
      expect(file.deployments).toEqual(firstFile.deployments)
      expect(file.oauth).toEqual(firstFile.oauth)

      const read = await server.inject({
        method: 'GET',
        url: `/v1/teams/${team.slug}/environments/sandbox`,
        headers: fixtures.as('limits-ok-1')
      })

      expect(read.result).toMatchObject({
        limits: CHANGED,
        pendingLimits: null,
        inProgress: false,
        models: [{ modelSlug: 'gpt-4o', status: 'active' }],
        latestOperation: { kind: 'limits', state: 'active' }
      })
    })

    test('accepts the maximum of both limits', async () => {
      const team = await deployedTeam('limits-ok-2')
      const { statusCode } = await put(team, 'limits-ok-2', {
        tokensPerMinute: MAX_TOKENS,
        requestsPerMinute: MAX_REQUESTS
      })

      expect(statusCode).toBe(202)
    })

    test('accepts the minimum of both limits', async () => {
      const team = await deployedTeam('limits-ok-3')
      const { statusCode } = await put(team, 'limits-ok-3', {
        tokensPerMinute: 1,
        requestsPerMinute: 1
      })

      expect(statusCode).toBe(202)
    })

    test('audits the change, never the Idempotency-Key', async () => {
      const team = await deployedTeam('limits-ok-4')
      const key = randomUUID()

      await put(team, 'limits-ok-4', CHANGED, { key })

      const events = await auditOf(team, { action: 'teamLimits.change' })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        outcome: 'success',
        role: 'admin',
        reason: 'sandbox: 2000 tokens, 120 requests a minute'
      })
      expect(JSON.stringify(events)).not.toContain(key)
    })
  })

  describe('beyond the bounds', () => {
    test.each([
      [
        'one token over the most',
        { tokensPerMinute: MAX_TOKENS + 1, requestsPerMinute: 60 }
      ],
      [
        'one request over the most',
        { tokensPerMinute: 1000, requestsPerMinute: MAX_REQUESTS + 1 }
      ],
      ['no tokens', { tokensPerMinute: 0, requestsPerMinute: 60 }],
      ['no requests', { tokensPerMinute: 1000, requestsPerMinute: 0 }],
      ['negative limits', { tokensPerMinute: -5, requestsPerMinute: -5 }]
    ])('refuses %s with the bounds, queuing nothing', async (_name, limits) => {
      const team = await deployedTeam(`limits-bad-${randomUUID().slice(0, 8)}`)
      const admin = team.admin
      const { statusCode, result } = await put(team, admin, limits)

      expect(statusCode).toBe(400)
      expect(result.code).toBe('limits-out-of-bounds')
      expect(result.limitBounds).toEqual({
        tokensPerMinute: { min: 1, max: MAX_TOKENS },
        requestsPerMinute: { min: 1, max: MAX_REQUESTS }
      })
      expect(await limitOperations(team)).toEqual([])
      expect(
        await auditOf(team, {
          action: 'teamLimits.change',
          outcome: 'failure',
          code: 'limits-out-of-bounds'
        })
      ).toHaveLength(1)
    })

    test.each([
      ['a missing limit', { tokensPerMinute: 1000 }],
      [
        'an unknown key',
        { tokensPerMinute: 1000, requestsPerMinute: 60, extra: 1 }
      ],
      ['a fraction', { tokensPerMinute: 1000.5, requestsPerMinute: 60 }],
      ['text', { tokensPerMinute: 'lots', requestsPerMinute: 60 }]
    ])('refuses %s as a bad request', async (_name, payload) => {
      const team = await fixtures.newTeam(
        `limits-shape-${randomUUID().slice(0, 8)}`
      )
      const { statusCode } = await put(team, team.admin, payload)

      expect(statusCode).toBe(400)
    })

    test.each([
      ['no key', undefined],
      ['a key that is not a UUID', 'abc']
    ])('refuses %s', async (_name, key) => {
      const team = await fixtures.newTeam(
        `limits-key-${randomUUID().slice(0, 8)}`
      )
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: `/v1/teams/${team.slug}/environments/sandbox/limits`,
        headers: {
          ...fixtures.as(team.admin),
          ...(key ? { 'idempotency-key': key } : {})
        },
        payload: CHANGED
      })

      expect(statusCode).toBe(400)
    })
  })

  describe('limits that change nothing', () => {
    test('are refused when they are what the file holds', async () => {
      const team = await deployedTeam('limits-same-1')
      const { statusCode, result } = await put(
        team,
        'limits-same-1',
        STARTING_LIMITS
      )

      expect(statusCode).toBe(409)
      expect(result.code).toBe('limits-unchanged')
      expect(await limitOperations(team)).toEqual([])
    })

    test('are refused when they are what a change in progress will set, and accepted when they undo it', async () => {
      const team = await deployedTeam('limits-same-2')

      await fixtures.seedOperation(team, {
        minute: 1,
        environment: 'sandbox',
        state: 'deploying',
        slot: 'active',
        items: [{ kind: 'limits', change: 'set', limits: CHANGED }]
      })

      const same = await put(team, 'limits-same-2', CHANGED)
      const undo = await put(team, 'limits-same-2', STARTING_LIMITS)

      expect(same.statusCode).toBe(409)
      expect(same.result.code).toBe('limits-unchanged')
      expect(undo.statusCode).toBe(202)
      expect(undo.result.operation.state).toBe('queued')
    })
  })

  describe('while another change holds the file', () => {
    test('waits as one operation, and a later request merges into it', async () => {
      const team = await deployedTeam('limits-wait-1')

      await fixtures.seedOperation(team, {
        minute: 1,
        environment: 'sandbox',
        state: 'deploying',
        slot: 'active'
      })

      const first = await put(team, 'limits-wait-1', CHANGED)
      const second = await put(team, 'limits-wait-1', {
        tokensPerMinute: 3000,
        requestsPerMinute: 30
      })

      expect(first.statusCode).toBe(202)
      expect(first.result.operation.state).toBe('queued')
      expect(second.statusCode).toBe(202)
      expect(second.result.operation.id).toBe(first.result.operation.id)
      expect(second.result.operation.changes).toHaveLength(2)
      // The seeded change is not a limits change: one waiting operation holds both.
      expect(await limitOperations(team)).toHaveLength(1)
    })
  })

  describe('an environment that is not set up', () => {
    test('is refused when the team has no file there', async () => {
      const team = await fixtures.newTeam('limits-none-1')
      const { statusCode, result } = await put(team, 'limits-none-1', CHANGED)

      expect(statusCode).toBe(409)
      expect(result.code).toBe('environment-not-set-up')
      expect(await limitOperations(team)).toEqual([])
      expect(
        await auditOf(team, {
          action: 'teamLimits.change',
          code: 'environment-not-set-up'
        })
      ).toHaveLength(1)
    })

    test('is refused when the file holds no model the catalogue knows', async () => {
      const team = await fixtures.newTeam('limits-none-2')

      vi.spyOn(mockTeamFileReader, 'getCurrentDocument').mockResolvedValue({
        document: { gateway: { limits: STARTING_LIMITS }, deployments: [] }
      })

      const { statusCode, result } = await put(team, 'limits-none-2', CHANGED)

      expect(statusCode).toBe(409)
      expect(result.code).toBe('environment-not-set-up')
    })

    test('is not found when this instance does not offer the environment', async () => {
      const team = await fixtures.newTeam('limits-none-3')
      const { statusCode, result } = await put(team, 'limits-none-3', CHANGED, {
        environment: 'infradev'
      })

      expect(statusCode).toBe(404)
      expect(result.code).toBe('environment-not-available')
    })

    test('is refused as upstream-unavailable when the file cannot be read', async () => {
      const team = await fixtures.newTeam('limits-none-4')

      vi.spyOn(mockTeamFileReader, 'getCurrentDocument').mockRejectedValue(
        new Error('GitHub is down')
      )

      const { statusCode, result } = await put(team, 'limits-none-4', CHANGED)

      expect(statusCode).toBe(502)
      expect(result.code).toBe('upstream-unavailable')
      expect(await limitOperations(team)).toEqual([])
    })
  })

  describe('a repeated Idempotency-Key', () => {
    test('replays the operation: 200, no second operation, commit or command', async () => {
      const team = await deployedTeam('limits-key-1')
      const key = randomUUID()
      const first = await put(team, 'limits-key-1', CHANGED, { key })

      await settleEvents()

      // The change has landed, so the same limits now change nothing: the
      // replay answers before that is looked at.
      const again = await put(team, 'limits-key-1', CHANGED, { key })

      expect(first.statusCode).toBe(202)
      expect(again.statusCode).toBe(200)
      expect(again.result.operation.id).toBe(first.result.operation.id)
      expect(again.headers.location).toBe(first.headers.location)
      expect(await limitOperations(team)).toHaveLength(1)
      expect(
        await auditOf(team, { action: 'teamLimits.change', outcome: 'success' })
      ).toHaveLength(1)
    })

    test('is refused when the key made a request for other limits', async () => {
      const team = await deployedTeam('limits-key-2')
      const key = randomUUID()

      await put(team, 'limits-key-2', CHANGED, { key })

      const other = await put(
        team,
        'limits-key-2',
        { tokensPerMinute: 5000, requestsPerMinute: 60 },
        { key }
      )

      expect(other.statusCode).toBe(409)
      expect(other.result.code).toBe('idempotency-key-reused')
      expect(await limitOperations(team)).toHaveLength(1)
    })

    test('is refused when the key made something that is not a limits change', async () => {
      const team = await deployedTeam('limits-key-3')
      const [deployment] = await server.db
        .collection('operations')
        .find({ teamId: team.teamId })
        .toArray()
      const { statusCode, result } = await put(team, 'limits-key-3', CHANGED, {
        key: deployment.idempotencyKeys[0]
      })

      expect(statusCode).toBe(409)
      expect(result.code).toBe('idempotency-key-reused')
    })
  })

  describe('a failure to queue the operation', () => {
    test('is refused as upstream-unavailable, audited, and nothing is left queued', async () => {
      const team = await deployedTeam('limits-fail-1')

      vi.spyOn(server.app.operations.operations, 'request').mockRejectedValue(
        new Error('the database is down')
      )

      const { statusCode, result } = await put(team, 'limits-fail-1', CHANGED)

      expect(statusCode).toBe(502)
      expect(result.code).toBe('upstream-unavailable')
      expect(await limitOperations(team)).toEqual([])
      expect(
        await auditOf(team, {
          action: 'teamLimits.change',
          outcome: 'failure',
          code: 'upstream-unavailable'
        })
      ).toHaveLength(1)
    })

    test('replays the operation another request made first under the same key, when it is the same change', async () => {
      const team = await deployedTeam('limits-fail-2')
      const earlier = await fixtures.seedOperation(team, {
        minute: 1,
        environment: 'sandbox',
        items: [{ kind: 'limits', change: 'set', limits: CHANGED }]
      })

      vi.spyOn(server.app.operations.operations, 'request').mockResolvedValue({
        operation: earlier,
        replay: true
      })

      const { statusCode, result } = await put(team, 'limits-fail-2', CHANGED)

      expect(statusCode).toBe(200)
      expect(result.operation.id).toBe(earlier._id)
      expect(
        await auditOf(team, { action: 'teamLimits.change', outcome: 'success' })
      ).toHaveLength(0)
    })

    test('refuses the key when the operation another request made under it was a different change', async () => {
      const team = await deployedTeam('limits-fail-3')
      const earlier = await fixtures.seedOperation(team, {
        minute: 1,
        environment: 'sandbox'
      })

      vi.spyOn(server.app.operations.operations, 'request').mockResolvedValue({
        operation: earlier,
        replay: true
      })

      const { statusCode, result } = await put(team, 'limits-fail-3', CHANGED)

      expect(statusCode).toBe(409)
      expect(result.code).toBe('idempotency-key-reused')
    })
  })

  describe('who may change the limits', () => {
    test('a Member is refused as admin-required, audited, and nothing is queued', async () => {
      const team = await deployedTeam('limits-who-1')

      await fixtures.addMember(team, 'limits-who-1-member')

      const { statusCode, result } = await put(
        team,
        'limits-who-1-member',
        CHANGED
      )

      expect(statusCode).toBe(403)
      expect(result.code).toBe('admin-required')
      expect(await limitOperations(team)).toEqual([])
      expect(
        await auditOf(team, { action: 'access.denied', code: 'admin-required' })
      ).toHaveLength(1)
    })

    test('someone outside the team is not found, audited, and nothing is read', async () => {
      const team = await deployedTeam('limits-who-2')

      await fixtures.signIn('limits-who-2-stranger')
      vi.spyOn(mockTeamFileReader, 'getCurrentDocument')

      const { statusCode } = await put(team, 'limits-who-2-stranger', CHANGED)

      expect(statusCode).toBe(404)
      expect(mockTeamFileReader.getCurrentDocument).not.toHaveBeenCalled()
      expect(
        await auditOf(team, { action: 'access.denied', code: 'not-a-member' })
      ).toHaveLength(1)
      expect(await limitOperations(team)).toEqual([])
    })

    test('a team that does not exist is not found', async () => {
      await fixtures.signIn('limits-who-3')

      const { statusCode } = await server.inject({
        method: 'PUT',
        url: '/v1/teams/no-such-team/environments/sandbox/limits',
        headers: {
          ...fixtures.as('limits-who-3'),
          'idempotency-key': randomUUID()
        },
        payload: CHANGED
      })

      expect(statusCode).toBe(404)
    })

    test('a person who has not signed in is refused', async () => {
      const team = await fixtures.newTeam('limits-who-4')
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: `/v1/teams/${team.slug}/environments/sandbox/limits`,
        headers: { 'idempotency-key': randomUUID() },
        payload: CHANGED
      })

      expect(statusCode).toBe(401)
    })
  })
})
