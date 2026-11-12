import { randomUUID } from 'node:crypto'

import { withTestUsers } from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

const ADD = { entryId: 'e1', modelSlug: 'gpt-4o', change: 'add' }
const LIMITS = { tokensPerMinute: 2000, requestsPerMinute: 30 }

describe('#team-operations routes', () => {
  let server
  let signIn
  let as
  let newTeam
  let addMember
  let seed

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    withTestUsers(server)
    ;({
      signIn,
      as,
      newTeam,
      addMember,
      seedOperation: seed
    } = createTeamFixtures(server))
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  function list(team, label, query = '') {
    return server.inject({
      method: 'GET',
      url: `/v1/teams/${team.slug}/operations${query}`,
      headers: as(label)
    })
  }

  describe('GET /v1/teams/{teamId}/operations', () => {
    test('lists the team’s own operations, newest first, and no other team’s', async () => {
      const team = await newTeam('ops-list-1')
      const other = await newTeam('ops-list-1-other')
      const oldest = await seed(team, { minute: 1 })
      const newest = await seed(team, { minute: 3 })
      const middle = await seed(team, { minute: 2, environment: 'sandbox' })

      await seed(other, { minute: 4 })

      const { statusCode, result } = await list(team, 'ops-list-1')

      expect(statusCode).toBe(200)
      expect(result.items.map(({ id }) => id)).toEqual([
        newest._id,
        middle._id,
        oldest._id
      ])
      expect(result.items[0]).toMatchObject({
        environment: 'infradev',
        kind: 'model',
        state: 'active',
        changes: [{ kind: 'model', change: 'add', modelSlug: 'gpt-4o' }]
      })
      expect(result.items[0].steps).toHaveLength(5)
    })

    test('names who asked, to a Member as to an Admin, and not the people of other teams', async () => {
      const team = await newTeam('ops-names-1')

      await addMember(team, 'ops-names-member')
      await seed(team, { minute: 1, requestedBy: 'ops-names-member' })

      const asMember = await list(team, 'ops-names-member')

      expect(asMember.statusCode).toBe(200)
      expect(asMember.result.items[0].requestedBy).toEqual({
        name: 'Name of ops-names-member'
      })
    })

    test('has no requester name for a change the platform made', async () => {
      const team = await newTeam('ops-names-2')

      await seed(team, { minute: 1 })

      const { result } = await list(team, 'ops-names-2')

      expect(result.items[0].requestedBy).toBeNull()
    })

    test('filters by environment', async () => {
      const team = await newTeam('ops-env-1')

      await seed(team, { minute: 1, environment: 'infradev' })

      const sandbox = await seed(team, { minute: 2, environment: 'sandbox' })
      const { result } = await list(team, 'ops-env-1', '?environment=sandbox')

      expect(result.items.map(({ id }) => id)).toEqual([sandbox._id])
    })

    test('filters open changes, which hold the team file, from recent ones, which ended', async () => {
      const team = await newTeam('ops-status-1')
      const ended = await seed(team, { minute: 1 })
      const open = await seed(team, {
        minute: 2,
        state: 'deploying',
        slot: 'active'
      })
      const waiting = await seed(team, {
        minute: 3,
        state: 'queued',
        slot: 'waiting'
      })

      const opened = await list(team, 'ops-status-1', '?status=open')
      const recent = await list(team, 'ops-status-1', '?status=recent')

      expect(opened.result.items.map(({ id }) => id)).toEqual([
        waiting._id,
        open._id
      ])
      expect(opened.result.items.every(({ open: held }) => held)).toBe(true)
      expect(recent.result.items.map(({ id }) => id)).toEqual([ended._id])
    })

    test('limits the list, ten by default, from 1 to 50', async () => {
      const team = await newTeam('ops-limit-1')

      for (let minute = 1; minute <= 12; minute += 1) {
        await seed(team, { minute })
      }

      const byDefault = await list(team, 'ops-limit-1')
      const two = await list(team, 'ops-limit-1', '?limit=2')
      const fifty = await list(team, 'ops-limit-1', '?limit=50')

      expect(byDefault.result.items).toHaveLength(10)
      expect(two.result.items).toHaveLength(2)
      expect(fifty.result.items).toHaveLength(12)
    })

    test.each([
      'limit=0',
      'limit=51',
      'limit=abc',
      'status=all',
      'environment=Infra%20Dev',
      'other=1'
    ])('refuses the query %s as a bad request', async (query) => {
      const team = await newTeam(`ops-bad-${randomUUID().slice(0, 8)}`)
      const { statusCode } = await list(team, team.admin, `?${query}`)

      expect(statusCode).toBe(400)
    })

    test('reads an operation with no kind as a model change', async () => {
      const team = await newTeam('ops-kind-1')

      await seed(team, { minute: 1, items: [ADD] })
      await seed(team, {
        minute: 2,
        items: [{ kind: 'limits', change: 'set', limits: LIMITS }]
      })

      const { result } = await list(team, 'ops-kind-1')

      expect(result.items.map(({ kind }) => kind)).toEqual(['limits', 'model'])
      expect(result.items[0].changes).toEqual([
        { kind: 'limits', change: 'set', limits: LIMITS }
      ])
    })

    test('keeps a revert and shows a failed change with its reason, run and reference', async () => {
      const team = await newTeam('ops-failed-1')

      await seed(team, {
        minute: 1,
        state: 'checks-failed',
        error: { code: 'operation-checks-failed', message: 'Not valid' },
        gitops: { submitRunUrl: 'https://github.com/DEFRA/x/actions/runs/1' }
      })

      const { result } = await list(team, 'ops-failed-1')

      expect(result.items[0]).toMatchObject({
        failureReason: 'Not valid',
        runUrl: 'https://github.com/DEFRA/x/actions/runs/1',
        supportReference: expect.stringMatching(/^AIP-/)
      })
    })

    test('does not list operations that are not changes to a team file', async () => {
      const team = await newTeam('ops-types-1')

      await seed(team, { minute: 1, type: 'break-glass' })

      const { result } = await list(team, 'ops-types-1')

      expect(result.items).toEqual([])
    })

    test('is not found for someone outside the team, and the refusal is audited', async () => {
      const team = await newTeam('ops-outsider-1')

      await signIn('ops-outsider-1-stranger')
      await seed(team, { minute: 1 })

      const { statusCode, result } = await list(team, 'ops-outsider-1-stranger')

      expect(statusCode).toBe(404)
      expect(JSON.stringify(result)).not.toMatch(/gpt-4o|infradev/)
      expect(
        await server.db.collection('auditEvents').countDocuments({
          action: 'access.denied',
          resourceId: team.teamId,
          code: 'not-a-member'
        })
      ).toBeGreaterThan(0)
    })

    test('is not found for a team that does not exist', async () => {
      await signIn('ops-nobody-1')

      const { statusCode } = await server.inject({
        method: 'GET',
        url: '/v1/teams/no-such-team/operations',
        headers: as('ops-nobody-1')
      })

      expect(statusCode).toBe(404)
    })

    test('needs a signed-in person', async () => {
      const team = await newTeam('ops-anon-1')
      const { statusCode } = await server.inject({
        method: 'GET',
        url: `/v1/teams/${team.slug}/operations`
      })

      expect(statusCode).toBe(401)
    })
  })

  describe('GET /v1/teams/{teamId}/operations/{operationId}', () => {
    function one(team, id, label) {
      return server.inject({
        method: 'GET',
        url: `/v1/teams/${team.slug}/operations/${id}`,
        headers: as(label)
      })
    }

    test('shows one operation of the team to a Member', async () => {
      const team = await newTeam('ops-one-1')

      await addMember(team, 'ops-one-1-member')

      const operation = await seed(team, {
        minute: 1,
        requestedBy: 'ops-one-1'
      })
      const { statusCode, result } = await one(
        team,
        operation._id,
        'ops-one-1-member'
      )

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        id: operation._id,
        state: 'active',
        requestedBy: { name: 'Name of ops-one-1' }
      })
      expect(result.steps.map(({ status }) => status)).toEqual([
        'done',
        'done',
        'done',
        'done',
        'done'
      ])
    })

    test('is not found for another team’s operation id, with the same answer as for an unknown one', async () => {
      const team = await newTeam('ops-one-2')
      const other = await newTeam('ops-one-2-other')
      const theirs = await seed(other, { minute: 1 })

      const foreign = await one(team, theirs._id, 'ops-one-2')
      const unknown = await one(team, randomUUID(), 'ops-one-2')

      expect(foreign.statusCode).toBe(404)
      expect(unknown.statusCode).toBe(404)
      const { requestId: _a, ...foreignBody } = foreign.result
      const { requestId: _b, ...unknownBody } = unknown.result

      expect(foreignBody).toEqual(unknownBody)
    })

    test('is not found for someone outside the team, and the refusal is audited', async () => {
      const team = await newTeam('ops-one-3')

      await signIn('ops-one-3-stranger')

      const operation = await seed(team, { minute: 1 })
      const { statusCode } = await one(
        team,
        operation._id,
        'ops-one-3-stranger'
      )

      expect(statusCode).toBe(404)
      expect(
        await server.db
          .collection('auditEvents')
          .countDocuments({ action: 'access.denied', resourceId: team.teamId })
      ).toBeGreaterThan(0)
    })

    test('is not found for a team that does not exist', async () => {
      await signIn('ops-one-4')

      const { statusCode } = await server.inject({
        method: 'GET',
        url: `/v1/teams/no-such-team/operations/${randomUUID()}`,
        headers: as('ops-one-4')
      })

      expect(statusCode).toBe(404)
    })
  })
})
