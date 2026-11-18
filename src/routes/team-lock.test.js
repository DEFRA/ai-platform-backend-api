import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

import { authFor, withTestUsers } from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

const SANDBOX = 'sandbox'
const INFRADEV = 'infradev'
// Each team asks for its own workload: another team's trust refuses it.
const cdpFor = (team, environments = [SANDBOX]) => ({
  host: 'cdp',
  service: `${team.label}-api`,
  environments
})
const NEW_LIMITS = { tokensPerMinute: 2000, requestsPerMinute: 120 }

// What a Platform Admin's Disable leaves on the team document.
const TEAM_ONLY = { status: 'disabled', disabledEnvironments: [] }
const SANDBOX_DISABLED = { status: 'disabled', disabledEnvironments: [SANDBOX] }
const OTHER_DISABLED = { status: 'disabled', disabledEnvironments: [INFRADEV] }
const SANDBOX_AFTER_PARTIAL_ENABLE = {
  status: 'active',
  disabledEnvironments: [SANDBOX]
}
const NOT_DISABLED = { status: 'active', disabledEnvironments: [] }

let settle

describe('#team lock: every change a disabled team or environment refuses', () => {
  let server
  let fixtures
  let config
  let configured
  let ctx

  beforeAll(async () => {
    // A short mock stage so a deployment can run to its end within a test.
    vi.stubEnv('TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS', '30')

    const { createServer } = await import('#/server.js')

    ;({ config } = await import('#/config.js'))
    server = await createServer()
    await server.initialize()
    withTestUsers(server)
    fixtures = createTeamFixtures(server)
    settle = () => server.app.operations.transport.worker.idle()
    configured = config.get('teamDeployment.environments')
    // The Infradev is offered too, and the team has no document there.
    config.set('teamDeployment.environments', [SANDBOX, INFRADEV])
    ctx = await seedContext('lock-main')
  })

  afterAll(async () => {
    await settle()
    config.set('teamDeployment.environments', configured)
    await server.stop({ timeout: 0 })
    vi.unstubAllEnvs()
  })

  afterEach(async () => {
    await settle()
  })

  // A team with gpt-4o deployed in the Sandbox (so it has a document, a
  // credential and a file there), a second Admin and a plain member.
  async function seedContext(label) {
    const team = await fixtures.newTeam(label)
    const deployed = await server.inject({
      method: 'POST',
      url: `/v1/teams/${team.teamId}/deployments`,
      headers: fixtures.asWithKey(label),
      payload: { modelSlugs: ['gpt-4o'], environment: SANDBOX }
    })

    expect(deployed.statusCode).toBe(201)
    await settle()
    await fixtures.addMember(team, `${label}-member`, 'user')

    const member = await server.db
      .collection('teamMembers')
      .findOne({ teamId: team.teamId, role: 'user' })
    const credential = await server.db
      .collection('credentials')
      .findOne({ teamId: team.teamId, environment: SANDBOX, tier: 'team' })

    return {
      ...team,
      label,
      memberId: member._id.toString(),
      deploymentId: deployed.result.deployments[0]._id,
      credentialId: credential._id.toString()
    }
  }

  function setLock(team, fields) {
    return server.db
      .collection('teams')
      .updateOne({ _id: new ObjectId(team.teamId) }, { $set: fields })
  }

  // Everything of the team a change could write, as it is stored.
  async function snapshot(team) {
    const where = { teamId: team.teamId }
    const [members, deployments, operations, credentials, stored] =
      await Promise.all([
        server.db.collection('teamMembers').find(where).toArray(),
        server.db.collection('teamDeployments').find(where).toArray(),
        server.db.collection('operations').find(where).toArray(),
        server.db.collection('credentials').find(where).toArray(),
        server.db
          .collection('teams')
          .findOne({ _id: new ObjectId(team.teamId) })
      ])

    return JSON.stringify({
      members,
      deployments,
      operations,
      credentials,
      stored
    })
  }

  function refusals(team, filter = {}) {
    return server.db
      .collection('auditEvents')
      .find({ teamId: team.teamId, code: 'team-disabled', ...filter })
      .sort({ at: 1, _id: 1 })
      .toArray()
  }

  // Each action in the lock map: the request, and the scope that locks it.
  const ACTIONS = [
    {
      name: 'change the team’s details',
      scope: 'team',
      request: (c) => ({
        method: 'PATCH',
        url: `/v1/teams/${c.slug}`,
        headers: fixtures.as(c.label),
        payload: { description: 'A new description' }
      })
    },
    {
      name: 'add a member',
      scope: 'team',
      request: (c) => ({
        method: 'POST',
        url: `/v1/teams/${c.slug}/members`,
        headers: fixtures.asWithKey(c.label),
        payload: { oid: randomUUID(), role: 'user' }
      })
    },
    {
      name: 'change a role',
      scope: 'team',
      request: (c) => ({
        method: 'PATCH',
        url: `/v1/teams/${c.slug}/members/${c.memberId}`,
        headers: fixtures.as(c.label),
        payload: { role: 'admin' }
      })
    },
    {
      name: 'remove a member',
      scope: 'team',
      request: (c) => ({
        method: 'DELETE',
        url: `/v1/teams/${c.slug}/members/${c.memberId}`,
        headers: fixtures.as(c.label)
      })
    },
    {
      name: 'set up a new environment',
      scope: 'team',
      request: (c) => ({
        method: 'POST',
        url: `/v1/teams/${c.teamId}/deployments`,
        headers: fixtures.asWithKey(c.label),
        payload: { modelSlugs: ['gpt-4o'], environment: INFRADEV }
      })
    },
    {
      name: 'deploy or change models',
      scope: 'environment',
      request: (c) => ({
        method: 'POST',
        url: `/v1/teams/${c.teamId}/deployments`,
        headers: fixtures.asWithKey(c.label),
        payload: { modelSlugs: ['gpt-4o'], environment: SANDBOX }
      })
    },
    {
      name: 'remove a model',
      scope: 'environment',
      request: (c) => ({
        method: 'DELETE',
        url: `/v1/teams/${c.teamId}/deployments/${c.deploymentId}`,
        headers: fixtures.as(c.label)
      })
    },
    {
      name: 'change limits',
      scope: 'environment',
      request: (c) => ({
        method: 'PUT',
        url: `/v1/teams/${c.slug}/environments/${SANDBOX}/limits`,
        headers: fixtures.asWithKey(c.label),
        payload: NEW_LIMITS
      })
    },
    {
      name: 'create a client secret',
      scope: 'environment',
      request: (c) => ({
        method: 'POST',
        url: `/v1/teams/${c.slug}/environments/${SANDBOX}/client-secrets`,
        headers: fixtures.asWithKey(c.label)
      })
    },
    {
      name: 'rotate a team credential',
      scope: 'environment',
      request: (c) => ({
        method: 'POST',
        url: `/v1/credentials/${c.credentialId}/rotate`,
        headers: fixtures.as(c.label)
      })
    },
    {
      name: 'reveal a team credential',
      scope: 'environment',
      request: (c) => ({
        method: 'POST',
        url: `/v1/credentials/${c.credentialId}/reveal`,
        headers: fixtures.as(c.label),
        payload: { reason: 'Handing it to the application owner' }
      })
    },
    {
      name: 'change an application',
      scope: 'environment',
      request: (c) => ({
        method: 'PATCH',
        url: `/v1/teams/${c.slug}/environments/${SANDBOX}/federations/an-id`,
        headers: fixtures.asWithKey(c.label),
        payload: { service: 'other-api' }
      })
    },
    {
      name: 'remove an application',
      scope: 'environment',
      request: (c) => ({
        method: 'DELETE',
        url: `/v1/teams/${c.slug}/environments/${SANDBOX}/federations/an-id`,
        headers: fixtures.as(c.label)
      })
    }
  ]
  const LOCKED = {
    team: [
      ['the team is disabled with no environment', TEAM_ONLY],
      ['the team is disabled with the Sandbox', SANDBOX_DISABLED]
    ],
    environment: [
      ['the team is disabled with the Sandbox', SANDBOX_DISABLED],
      [
        'the Sandbox is still disabled after a partial enable',
        SANDBOX_AFTER_PARTIAL_ENABLE
      ]
    ]
  }
  // The same request in a state that does not lock it must get past the lock.
  const OPEN = {
    team: [
      ['the team is not disabled', NOT_DISABLED],
      ['only the Sandbox is disabled', SANDBOX_AFTER_PARTIAL_ENABLE]
    ],
    environment: [
      ['the team is not disabled', NOT_DISABLED],
      ['the team is disabled with no environment', TEAM_ONLY],
      ['only the Infradev is disabled', OTHER_DISABLED]
    ]
  }

  // Every refusal first, on one team that nothing changes: none of these
  // writes anything, so each is compared with the team as it was.
  describe.each(ACTIONS)('$name', ({ scope, request }) => {
    test.each(LOCKED[scope])(
      'is refused 409 team-disabled when %s, with no reason, nothing written and the refusal audited',
      async (_state, fields) => {
        await setLock(ctx, fields)

        const before = await snapshot(ctx)
        const refusedBefore = (await refusals(ctx)).length
        const { statusCode, result } = await server.inject(request(ctx))

        expect(statusCode).toBe(409)
        expect(result).toMatchObject({
          code: 'team-disabled',
          message: 'This team is disabled. You can view it but not change it.'
        })
        expect(JSON.stringify(result)).not.toMatch(/reason/i)
        expect(await snapshot(ctx)).toBe(before)

        const rows = await refusals(ctx)

        expect(rows).toHaveLength(refusedBefore + 1)
        expect(rows.at(-1)).toMatchObject({
          action: 'access.denied',
          resource: 'team',
          resourceId: ctx.teamId,
          outcome: 'failure',
          role: 'admin',
          ...(scope === 'environment' && { environment: SANDBOX })
        })
      }
    )
  })

  // The same request in a state that does not lock it must get past the lock.
  // These may change the team, so each action has a team of its own.
  describe.each(ACTIONS)(
    '$name, when it is not locked',
    ({ scope, request }) => {
      let own

      beforeAll(async () => {
        own = await seedContext(`lock-open-${randomUUID().slice(0, 8)}`)
      })

      test.each(OPEN[scope])(
        'is not refused as team-disabled when %s',
        async (_state, fields) => {
          await setLock(own, fields)

          const { result } = await server.inject(request(own))

          expect(result?.code).not.toBe('team-disabled')
        }
      )
    }
  )

  describe('an application requested in a disabled environment', () => {
    function federate(team, body = cdpFor(team)) {
      return server.inject({
        method: 'POST',
        url: `/v1/teams/${team.slug}/federations`,
        headers: fixtures.asWithKey(team.label),
        payload: body
      })
    }

    test('is refused 409 federation-refused with team-disabled for the environment, and nothing is queued', async () => {
      const team = await seedContext('lock-fed-1')

      await setLock(team, SANDBOX_DISABLED)

      const before = await snapshot(team)
      const { statusCode, result } = await federate(team)

      expect(statusCode).toBe(409)
      expect(result).toMatchObject({
        code: 'federation-refused',
        environments: [{ environment: SANDBOX, code: 'team-disabled' }]
      })
      expect(JSON.stringify(result)).not.toMatch(/reason/i)
      expect(await snapshot(team)).toBe(before)
      expect(
        await server.db
          .collection('auditEvents')
          .find({ resourceId: team.teamId, code: 'team-disabled' })
          .toArray()
      ).toEqual([
        expect.objectContaining({
          action: 'teamFederation.request',
          outcome: 'failure',
          reason: SANDBOX
        })
      ])
    })

    test('is refused as a whole when one environment asked for is disabled and another is not', async () => {
      const team = await seedContext('lock-fed-2')

      await setLock(team, OTHER_DISABLED)

      const { statusCode, result } = await federate(team, {
        ...cdpFor(team),
        environments: [SANDBOX, INFRADEV]
      })

      expect(statusCode).toBe(409)
      expect(result.environments).toEqual([
        { environment: INFRADEV, code: 'team-disabled' }
      ])
      expect(
        await server.db
          .collection('operations')
          .countDocuments({ teamId: team.teamId, 'items.kind': 'federation' })
      ).toBe(0)
    })

    test('the dry run reports team-disabled for the environment and changes nothing', async () => {
      const team = await seedContext('lock-fed-3')

      await setLock(team, SANDBOX_DISABLED)

      const before = await snapshot(team)
      const { statusCode, result } = await server.inject({
        method: 'POST',
        url: `/v1/teams/${team.slug}/federations/check`,
        headers: fixtures.as(team.label),
        payload: cdpFor(team)
      })

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        environments: [{ environment: SANDBOX, code: 'team-disabled' }]
      })
      expect(await snapshot(team)).toBe(before)
    })

    test.each([
      ['the team alone is disabled', TEAM_ONLY],
      ['only another environment is disabled', OTHER_DISABLED]
    ])(
      'is accepted when %s, and the dry run says it can',
      async (_name, fields) => {
        const team = await seedContext(
          `lock-fed-4-${fields.disabledEnvironments.length}`
        )

        await setLock(team, fields)

        const check = await server.inject({
          method: 'POST',
          url: `/v1/teams/${team.slug}/federations/check`,
          headers: fixtures.as(team.label),
          payload: cdpFor(team)
        })
        const { statusCode } = await federate(team)

        expect(check.result).toEqual({
          environments: [{ environment: SANDBOX, code: null }]
        })
        expect(statusCode).toBe(202)
      }
    )
  })

  describe('an environment that is not disabled stays usable while the team is', () => {
    test('limits, client secrets and rotating a credential still work', async () => {
      const team = await seedContext('lock-open-1')

      await setLock(team, OTHER_DISABLED)

      const limits = await server.inject({
        method: 'PUT',
        url: `/v1/teams/${team.slug}/environments/${SANDBOX}/limits`,
        headers: fixtures.asWithKey(team.label),
        payload: NEW_LIMITS
      })
      const secret = await server.inject({
        method: 'POST',
        url: `/v1/teams/${team.slug}/environments/${SANDBOX}/client-secrets`,
        headers: fixtures.asWithKey(team.label)
      })
      const rotated = await server.inject({
        method: 'POST',
        url: `/v1/credentials/${team.credentialId}/rotate`,
        headers: fixtures.as(team.label)
      })

      expect(limits.statusCode).toBe(202)
      expect(secret.statusCode).toBe(201)
      expect(rotated.statusCode).toBe(200)
    })

    test('a model can be requested and removed in it', async () => {
      const team = await seedContext('lock-open-2')

      await setLock(team, TEAM_ONLY)

      const removed = await server.inject({
        method: 'DELETE',
        url: `/v1/teams/${team.teamId}/deployments/${team.deploymentId}`,
        headers: fixtures.as(team.label)
      })

      expect(removed.statusCode).toBeLessThan(300)
    })
  })

  describe('what stays open while the team and the Sandbox are disabled', () => {
    test('every read answers, and a team Admin can revoke a client secret and a team credential', async () => {
      const team = await seedContext('lock-open-3')
      const secret = await server.inject({
        method: 'POST',
        url: `/v1/teams/${team.slug}/environments/${SANDBOX}/client-secrets`,
        headers: fixtures.asWithKey(team.label)
      })

      expect(secret.statusCode).toBe(201)

      await setLock(team, SANDBOX_DISABLED)

      const reads = [
        `/v1/teams/${team.slug}`,
        `/v1/teams/${team.slug}/environments`,
        `/v1/teams/${team.slug}/environments/${SANDBOX}`,
        `/v1/teams/${team.slug}/deployments`,
        `/v1/teams/${team.slug}/operations`,
        `/v1/teams/${team.slug}/status-changes`,
        `/v1/credentials/${team.credentialId}`
      ]

      for (const url of reads) {
        const { statusCode } = await server.inject({
          method: 'GET',
          url,
          headers: fixtures.as(team.label)
        })

        expect(statusCode, url).toBe(200)
      }

      const revokedSecret = await server.inject({
        method: 'DELETE',
        url: `/v1/credentials/${secret.result.credential.id}`,
        headers: fixtures.as(team.label)
      })
      const revokedCredential = await server.inject({
        method: 'DELETE',
        url: `/v1/credentials/${team.credentialId}`,
        headers: fixtures.as(team.label)
      })

      expect(revokedSecret.statusCode).toBe(204)
      expect(revokedCredential.statusCode).toBe(204)
      expect(await refusals(team)).toEqual([])
    })

    test('a Platform Admin can still remove a member and disable the credentials through the admin routes', async () => {
      const team = await seedContext('lock-open-4')
      const admin = authFor('lock-platform-admin', {
        roles: ['research-user', 'platform-admin']
      })

      await setLock(team, SANDBOX_DISABLED)

      const removed = await server.inject({
        method: 'DELETE',
        url: `/v1/admin/teams/${team.teamId}/members/${team.memberId}`,
        headers: admin
      })
      const disabled = await server.inject({
        method: 'POST',
        url: `/v1/admin/team-deployments/${team.teamId}/${SANDBOX}/credentials/disable`,
        headers: { ...admin, 'idempotency-key': randomUUID() },
        payload: { reason: 'Because' }
      })

      expect(removed.statusCode).toBe(204)
      expect(disabled.statusCode).toBe(200)
      expect(await refusals(team)).toEqual([])
    })
  })
})
