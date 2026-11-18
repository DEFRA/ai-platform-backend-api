import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

import {
  appAuth,
  authFor,
  withTestUsers
} from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

const ADMIN = 'fed-remove-admin'
const CDP = { host: 'cdp', service: 'beta-api', environments: ['sandbox'] }
const REASON = 'The application was federated by mistake'
const ACTION = 'admin.federation.remove'
const MISSING_ID = '000000000000000000000000'

let settleEvents

describe('#admin POST …/federations/{federationId}/remove', () => {
  let server
  let fixtures

  beforeAll(async () => {
    // A short mock stage so a removal can run to its end within a test.
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
    // Another team trusting a workload refuses it: each test starts with no
    // applications anywhere.
    await server.db
      .collection('teamDeployments')
      .updateMany({}, { $set: { federations: [] } })
    vi.restoreAllMocks()
  })

  const asAdmin = () =>
    authFor(ADMIN, { roles: ['research-user', 'platform-admin'] })
  const withKey = (headers = asAdmin(), key = randomUUID()) => ({
    ...headers,
    'idempotency-key': key
  })

  // A team with a CDP application ready in the Sandbox.
  async function readyApplication(label, service = CDP.service) {
    const team = await fixtures.newTeam(label)
    const deployed = await server.inject({
      method: 'POST',
      url: `/v1/teams/${team.teamId}/deployments`,
      headers: fixtures.asWithKey(label),
      payload: { modelSlugs: ['gpt-4o'], environment: 'sandbox' }
    })

    expect(deployed.statusCode).toBe(201)
    await settleEvents()

    const { result } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${team.slug}/federations`,
      headers: fixtures.asWithKey(label),
      payload: { ...CDP, service }
    })

    await settleEvents()

    return { team, id: result.federations[0].id }
  }

  const url = (teamId, id, environment = 'sandbox') =>
    `/v1/admin/team-deployments/${teamId}/${environment}/federations/${id}/remove`

  function remove(
    teamId,
    id,
    { headers = withKey(), payload = { reason: REASON }, environment } = {}
  ) {
    return server.inject({
      method: 'POST',
      url: url(teamId, id, environment),
      headers,
      payload
    })
  }

  const statusOf = async (teamId, id) =>
    (
      await server.db
        .collection('teamDeployments')
        .findOne({ teamId, environment: 'sandbox' })
    ).federations.find((entry) => entry.id === id).status

  const auditOf = (teamId, filter = {}) =>
    server.db
      .collection('auditEvents')
      .find({ teamId, action: ACTION, ...filter })
      .toArray()

  test('removes the application as a Platform Admin who is not a member: 202 with the application and its operation, then removed, with one audit event', async () => {
    const { team, id } = await readyApplication('fed-remove-1')

    const { statusCode, result } = await remove(team.teamId, id)

    expect(statusCode).toBe(202)
    expect(result.federation).toMatchObject({ id, status: 'removing' })
    expect(result.operationId).toEqual(expect.any(String))
    expect(result.operationId).toBe(result.federation.operationId)

    await settleEvents()

    expect(await statusOf(team.teamId, id)).toBe('removed')
    expect(await auditOf(team.teamId)).toEqual([
      expect.objectContaining({
        role: 'platform-admin',
        resource: 'teamFederation',
        resourceId: id,
        environment: 'sandbox',
        outcome: 'success',
        reason: REASON
      })
    ])
  })

  test('works on a Disabled team, which refuses its own Admin the same removal', async () => {
    const { team, id } = await readyApplication('fed-remove-2')

    await server.db
      .collection('teams')
      .updateOne(
        { _id: new ObjectId(team.teamId) },
        { $set: { status: 'disabled', disabledEnvironments: ['sandbox'] } }
      )

    const byTeamAdmin = await server.inject({
      method: 'DELETE',
      url: `/v1/teams/${team.slug}/environments/sandbox/federations/${id}`,
      headers: fixtures.as('fed-remove-2')
    })
    const { statusCode } = await remove(team.teamId, id)

    expect(byTeamAdmin.statusCode).toBe(409)
    expect(byTeamAdmin.result.code).toBe('team-disabled')
    expect(statusCode).toBe(202)

    await settleEvents()

    expect(await statusOf(team.teamId, id)).toBe('removed')
  })

  test('answers an application already removed with 200 and records nothing', async () => {
    const { team, id } = await readyApplication('fed-remove-3')

    await remove(team.teamId, id)
    await settleEvents()

    const { statusCode, result } = await remove(team.teamId, id)

    expect(statusCode).toBe(200)
    expect(result.federation).toMatchObject({ id, status: 'removed' })
    expect(await auditOf(team.teamId)).toHaveLength(1)
  })

  test('a repeat of the Idempotency-Key is a 200 with the same application and operation, one event and one operation; another reason is 409 idempotency-key-reused', async () => {
    const { team, id } = await readyApplication('fed-remove-4')
    const headers = withKey()
    const first = await remove(team.teamId, id, { headers })
    const again = await remove(team.teamId, id, { headers })
    const reused = await remove(team.teamId, id, {
      headers,
      payload: { reason: 'Another reason' }
    })

    expect(first.statusCode).toBe(202)
    expect(again.statusCode).toBe(200)
    expect(again.result.operationId).toBe(first.result.operationId)
    expect(again.result.federation.id).toBe(id)
    expect(reused.statusCode).toBe(409)
    expect(reused.result.code).toBe('idempotency-key-reused')
    expect(await auditOf(team.teamId)).toHaveLength(1)

    const operations = await server.db
      .collection('operations')
      .find({ teamId: team.teamId, 'items.change': 'remove' })
      .toArray()

    expect(operations).toHaveLength(1)
  })

  test('trims the reason, and refuses an application still being set up as 409 federation-in-progress, audited', async () => {
    const { team, id } = await readyApplication('fed-remove-5')

    await server.db
      .collection('teamDeployments')
      .updateOne(
        { teamId: team.teamId, environment: 'sandbox' },
        { $set: { 'federations.0.status': 'setting-up' } }
      )

    const { statusCode, result } = await remove(team.teamId, id, {
      payload: { reason: `  ${REASON}  ` }
    })

    expect(statusCode).toBe(409)
    expect(result.code).toBe('federation-in-progress')
    expect(await auditOf(team.teamId, { outcome: 'failure' })).toEqual([
      expect.objectContaining({
        role: 'platform-admin',
        code: 'federation-in-progress'
      })
    ])
  })

  test.each([
    ['no reason', {}, 'reason-required'],
    ['a reason of only spaces', { reason: '   ' }, 'reason-required'],
    [
      'a reason of 501 characters',
      { reason: 'x'.repeat(501) },
      'reason-too-long'
    ]
  ])('refuses %s as %s and removes nothing', async (_name, payload, code) => {
    const { team, id } = await readyApplication('fed-remove-6')
    const { statusCode, result } = await remove(team.teamId, id, { payload })

    expect(statusCode).toBe(400)
    expect(result.code).toBe(code)
    expect(await statusOf(team.teamId, id)).toBe('ready')
  })

  test('refuses a request with no Idempotency-Key as invalid-request', async () => {
    const { team, id } = await readyApplication('fed-remove-7')
    const { statusCode, result } = await remove(team.teamId, id, {
      headers: asAdmin()
    })

    expect(statusCode).toBe(400)
    expect(result.code).toBe('invalid-request')
    expect(await statusOf(team.teamId, id)).toBe('ready')
  })

  test('answers 404 federation-not-found for an id the deployment does not hold, and 404 deployment-not-found for an unknown team or an environment not offered', async () => {
    const { team, id } = await readyApplication('fed-remove-8')
    const missing = await remove(team.teamId, 'no-such-id')
    const unknownTeam = await remove(MISSING_ID, id)
    const unknownEnvironment = await remove(team.teamId, id, {
      environment: 'no-such-environment'
    })

    expect(missing.statusCode).toBe(404)
    expect(missing.result.code).toBe('federation-not-found')
    expect(unknownTeam.statusCode).toBe(404)
    expect(unknownTeam.result.code).toBe('deployment-not-found')
    expect(unknownEnvironment.statusCode).toBe(404)
    expect(unknownEnvironment.result.code).toBe('deployment-not-found')
    expect(await statusOf(team.teamId, id)).toBe('ready')
  })

  test('answers 404 federation-not-found for another team’s application', async () => {
    const { id } = await readyApplication('fed-remove-9')
    const other = await readyApplication('fed-remove-9-other', 'gamma-api')
    const { statusCode, result } = await remove(other.team.teamId, id)

    expect(statusCode).toBe(404)
    expect(result.code).toBe('federation-not-found')
    expect(await statusOf(other.team.teamId, other.id)).toBe('ready')
  })

  test('refuses a person who is not a Platform Admin with 403 and the app-only token with 401, removing nothing', async () => {
    const { team, id } = await readyApplication('fed-remove-10')
    const person = await remove(team.teamId, id, {
      headers: withKey(authFor('fed-remove-10'))
    })
    const teamAdmin = await remove(team.teamId, id, {
      headers: withKey(fixtures.as('fed-remove-10'))
    })
    const app = await remove(team.teamId, id, {
      headers: withKey(appAuth())
    })

    expect(person.statusCode).toBe(403)
    expect(person.result.code).toBe('platform-admin-required')
    expect(teamAdmin.statusCode).toBe(403)
    expect(teamAdmin.result.code).toBe('platform-admin-required')
    expect(app.statusCode).toBe(401)
    expect(await statusOf(team.teamId, id)).toBe('ready')
  })

  test('is refused as upstream-unavailable, leaving the application as it was, when the operation cannot be queued', async () => {
    const { team, id } = await readyApplication('fed-remove-11')

    vi.spyOn(server.app.operations.operations, 'request').mockRejectedValue(
      new Error('the database is down')
    )

    const { statusCode, result } = await remove(team.teamId, id)

    expect(statusCode).toBe(502)
    expect(result.code).toBe('upstream-unavailable')
    expect(await statusOf(team.teamId, id)).toBe('ready')
    expect(await auditOf(team.teamId, { outcome: 'failure' })).toHaveLength(1)
  })
})
