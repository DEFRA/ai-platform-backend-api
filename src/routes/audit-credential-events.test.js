import { randomUUID } from 'node:crypto'

import { authFor, withTestUsers } from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

const ADMIN = 'audit-credential-admin'
const ENVIRONMENT = 'sandbox'
const CDP = { host: 'cdp', service: 'beta-api', environments: [ENVIRONMENT] }
const LIMITS = { tokensPerMinute: 2000, requestsPerMinute: 120 }

let settleEvents

// The Audit log's Team and Environment filters read the `teamId` and
// `environment` an event carries (design F, DF1): an event without them is
// not found by either.
describe('#audit: credential, federation and limits events carry the team and environment', () => {
  let server
  let fixtures
  let team
  let secretId
  let credentialId

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

  const send = (method, url, { label = team.admin, payload } = {}) =>
    server.inject({
      method,
      url,
      headers: fixtures.asWithKey(label),
      payload
    })

  // The events the Audit log finds for the team and environment, by action.
  async function found(action) {
    const { result } = await server.inject({
      method: 'GET',
      url: `/v1/admin/audit?team=${team.teamId}&environment=${ENVIRONMENT}&action=${action}`,
      headers: authFor(ADMIN, { roles: ['research-user', 'platform-admin'] })
    })

    return result.events
  }

  async function setUp() {
    team = await fixtures.newTeam(`audit-cred-${randomUUID().slice(0, 6)}`)

    const deployed = await send(
      'POST',
      `/v1/teams/${team.teamId}/deployments`,
      {
        payload: { modelSlugs: ['gpt-4o'], environment: ENVIRONMENT }
      }
    )

    expect(deployed.statusCode).toBe(201)
    await settleEvents()

    const secret = await send(
      'POST',
      `/v1/teams/${team.slug}/environments/${ENVIRONMENT}/client-secrets`
    )

    expect(secret.statusCode).toBe(201)
    secretId = secret.result.credential.id
    credentialId = (
      await server.db.collection('credentials').findOne({
        teamId: team.teamId,
        environment: ENVIRONMENT,
        tier: 'team'
      })
    )._id.toString()
  }

  describe('what a team does', () => {
    beforeAll(setUp)

    test('finds the team credential granted with the first model and the client secret added', async () => {
      const events = await found('credential.issue')

      expect(events).toHaveLength(2)
      expect(events).toEqual(
        Array(2).fill(
          expect.objectContaining({
            outcome: 'success',
            team: expect.objectContaining({ id: team.teamId }),
            environment: ENVIRONMENT
          })
        )
      )
    })

    test('finds the limits changed, and the credential rotated, revealed and revoked', async () => {
      const limits = await send(
        'PUT',
        `/v1/teams/${team.slug}/environments/${ENVIRONMENT}/limits`,
        { payload: LIMITS }
      )
      const rotated = await send(
        'POST',
        `/v1/credentials/${credentialId}/rotate`
      )
      const revealed = await send(
        'POST',
        `/v1/credentials/${credentialId}/reveal`,
        { payload: { reason: 'Handing it to the application owner' } }
      )
      const revoked = await send('DELETE', `/v1/credentials/${secretId}`)

      expect([
        limits.statusCode,
        rotated.statusCode,
        revealed.statusCode,
        revoked.statusCode
      ]).toEqual([202, 200, 200, 204])

      await settleEvents()

      for (const action of [
        'teamLimits.change',
        'credential.rotate',
        'credential.reveal',
        'credential.revoke'
      ]) {
        expect(await found(action), action).toEqual([
          expect.objectContaining({
            outcome: 'success',
            team: expect.objectContaining({ id: team.teamId }),
            environment: ENVIRONMENT
          })
        ])
      }
    })

    test('finds an application requested, changed and removed', async () => {
      const requested = await send(
        'POST',
        `/v1/teams/${team.slug}/federations`,
        { payload: CDP }
      )

      await settleEvents()

      const id = requested.result.federations[0].id
      const base = `/v1/teams/${team.slug}/environments/${ENVIRONMENT}/federations/${id}`
      const changed = await send('PATCH', base, {
        payload: { service: 'delta-api' }
      })

      await settleEvents()

      const removed = await send('DELETE', base)

      expect([
        requested.statusCode,
        changed.statusCode,
        removed.statusCode
      ]).toEqual([202, 202, 202])

      for (const action of [
        'teamFederation.request',
        'teamFederation.change',
        'teamFederation.remove'
      ]) {
        expect(await found(action), action).toEqual([
          expect.objectContaining({
            outcome: 'success',
            team: expect.objectContaining({ id: team.teamId }),
            environment: ENVIRONMENT
          })
        ])
      }
    })
  })

  describe('what is refused while credentials are disabled', () => {
    beforeAll(async () => {
      await setUp()
      await server.db
        .collection('teamDeployments')
        .updateOne(
          { teamId: team.teamId, environment: ENVIRONMENT },
          { $set: { adminBlocked: true } }
        )
    })

    test('finds each refusal, with the code', async () => {
      const refused = [
        await send(
          'POST',
          `/v1/teams/${team.slug}/environments/${ENVIRONMENT}/client-secrets`
        ),
        await send('POST', `/v1/credentials/${credentialId}/rotate`),
        await send('POST', `/v1/teams/${team.slug}/federations`, {
          payload: CDP
        })
      ]

      expect(refused.map(({ statusCode }) => statusCode)).toEqual([
        409, 409, 409
      ])

      for (const action of [
        'credential.issue',
        'credential.rotate',
        'teamFederation.request'
      ]) {
        expect(await found(action), action).toContainEqual(
          expect.objectContaining({
            outcome: 'failure',
            code: 'credentials-disabled',
            team: expect.objectContaining({ id: team.teamId }),
            environment: ENVIRONMENT
          })
        )
      }
    })
  })
})
