import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

import { withTestUsers } from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const NINETY_DAYS_MS = 90 * MS_PER_DAY
const A_MINUTE_MS = 60 * 1000

describe('#team-client-secrets routes', () => {
  let server
  let fixtures
  let config
  let mockTeamFileReader
  let settle
  let configured

  beforeAll(async () => {
    // A short mock stage so a deployment can run to its end within a test.
    vi.stubEnv('TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS', '30')

    const { createServer } = await import('#/server.js')

    ;({ config } = await import('#/config.js'))
    ;({ mockTeamFileReader } =
      await import('#/adapters/mock-team-file-reader.js'))
    server = await createServer()
    await server.initialize()
    withTestUsers(server)
    fixtures = createTeamFixtures(server)
    settle = () => server.app.operations.transport.worker.idle()
    configured = {
      environments: config.get('teamDeployment.environments'),
      clientSecretEnvironments: config.get(
        'teamDeployment.clientSecretEnvironments'
      )
    }
  })

  afterAll(async () => {
    await settle()
    await server.stop({ timeout: 0 })
    vi.unstubAllEnvs()
  })

  afterEach(async () => {
    await settle()
    config.set('teamDeployment.environments', configured.environments)
    config.set(
      'teamDeployment.clientSecretEnvironments',
      configured.clientSecretEnvironments
    )
    vi.restoreAllMocks()
  })

  // A team with gpt-4o deployed in the Sandbox: its file is on `main` (as the
  // mock holds it), so the Sandbox is set up, and the team's own credential
  // for it was made when the model turned active.
  async function deployedTeam(label) {
    const team = await fixtures.newTeam(label)
    const { statusCode } = await server.inject({
      method: 'POST',
      url: `/v1/teams/${team.teamId}/deployments`,
      headers: fixtures.asWithKey(label),
      payload: { modelSlugs: ['gpt-4o'], environment: 'sandbox' }
    })

    expect(statusCode).toBe(201)
    await settle()

    return team
  }

  // The Sandbox and Infradev are offered, and the team has a file in Infradev
  // too (the mock holds the Sandbox's from the deployment).
  function withInfradev(team) {
    config.set('teamDeployment.environments', ['sandbox', 'infradev'])

    const original =
      mockTeamFileReader.getCurrentDocument.bind(mockTeamFileReader)

    vi.spyOn(mockTeamFileReader, 'getCurrentDocument').mockImplementation(
      async (params) =>
        params.path === `environments/infradev/${team.slug}.json`
          ? {
              document: {
                schemaVersion: 1,
                revision: 1,
                environment: 'infradev',
                status: 'active',
                team: { slug: team.slug, serviceCode: 'ABC' },
                deployments: [],
                gateway: { credentialType: 'oauth', allowedDeployments: [] },
                oauth: {
                  federations: [],
                  externalClients: [],
                  secretsAllowed: true
                }
              },
              sha: 'a'.repeat(40)
            }
          : original(params)
    )
  }

  function add(
    team,
    label,
    { key = randomUUID(), environment = 'sandbox' } = {}
  ) {
    return server.inject({
      method: 'POST',
      url: `/v1/teams/${team.slug}/environments/${environment}/client-secrets`,
      headers: { ...fixtures.as(label), 'idempotency-key': key }
    })
  }

  function secretsOf(team, environment = 'sandbox') {
    return server.db
      .collection('credentials')
      .find({ teamId: team.teamId, environment, tier: 'team' })
      .sort({ createdAt: 1 })
      .toArray()
  }

  function reveal(credentialId, label) {
    return server.inject({
      method: 'POST',
      url: `/v1/credentials/${credentialId}/reveal`,
      headers: fixtures.as(label),
      payload: { reason: 'Handing it to the application owner' }
    })
  }

  function auditOf(filter) {
    return server.db.collection('auditEvents').find(filter).toArray()
  }

  describe('POST /v1/teams/{teamId}/environments/{environment}/client-secrets', () => {
    test('an Admin adds a secret: 201 with the credential and the secret once, never cached', async () => {
      const team = await deployedTeam('cs-add-1')
      const before = Date.now()

      const { statusCode, result, headers } = await add(team, 'cs-add-1')

      expect(statusCode).toBe(201)
      expect(headers['cache-control']).toBe('no-store')
      expect(result.secret).toEqual(expect.stringContaining('mock-oauth-'))
      expect(result.credential).toEqual({
        id: expect.any(String),
        keyHint: result.secret.slice(-4),
        expiresAt: expect.any(String),
        environment: 'sandbox'
      })

      const lifetime = new Date(result.credential.expiresAt) - before

      expect(Math.abs(lifetime - NINETY_DAYS_MS)).toBeLessThan(A_MINUTE_MS)
    })

    test('keeps the secret only in the vault: the record holds no value, an Admin can reveal it', async () => {
      const team = await deployedTeam('cs-add-2')
      const { result } = await add(team, 'cs-add-2')

      const stored = (await secretsOf(team)).find(
        ({ _id }) => _id.toString() === result.credential.id
      )

      expect(stored).toMatchObject({
        teamId: team.teamId,
        tier: 'team',
        credentialType: 'oauth',
        environment: 'sandbox',
        status: 'active',
        expiresAt: result.credential.expiresAt
      })
      expect(JSON.stringify(stored)).not.toContain(result.secret)

      const revealed = await reveal(result.credential.id, 'cs-add-2')

      expect(revealed.statusCode).toBe(200)
      expect(revealed.headers['cache-control']).toBe('no-store')
      expect(revealed.result.secret).toBe(result.secret)
    })

    test('audits the addition with the Admin and the credential, never the value', async () => {
      const team = await deployedTeam('cs-audit-1')
      const { result } = await add(team, 'cs-audit-1')

      const events = await auditOf({
        action: 'credential.issue',
        resourceId: result.credential.id
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ outcome: 'success', role: 'admin' })
      expect(JSON.stringify(events)).not.toContain(result.secret)
    })

    test('a replayed Idempotency-Key answers 200 with the credential, no secret, and adds nothing', async () => {
      const team = await deployedTeam('cs-replay-1')
      const key = randomUUID()
      const first = await add(team, 'cs-replay-1', { key })
      const count = (await secretsOf(team)).length

      const replay = await add(team, 'cs-replay-1', { key })

      expect(replay.statusCode).toBe(200)
      expect(replay.headers['cache-control']).toBe('no-store')
      expect(replay.result.credential).toEqual(first.result.credential)
      expect(replay.result.secret).toBeUndefined()
      expect(await secretsOf(team)).toHaveLength(count)
    })

    test('a key made for another environment is 409 idempotency-key-reused', async () => {
      const team = await deployedTeam('cs-replay-2')

      withInfradev(team)

      const key = randomUUID()

      expect((await add(team, 'cs-replay-2', { key })).statusCode).toBe(201)

      const { statusCode, result } = await add(team, 'cs-replay-2', {
        key,
        environment: 'infradev'
      })

      expect(statusCode).toBe(409)
      expect(result.code).toBe('idempotency-key-reused')
      expect(await secretsOf(team, 'infradev')).toHaveLength(0)
    })

    test('the team credential made with its first model counts in the three', async () => {
      const team = await deployedTeam('cs-limit-1')

      expect(await secretsOf(team)).toHaveLength(1)
      expect((await add(team, 'cs-limit-1')).statusCode).toBe(201)
      expect((await add(team, 'cs-limit-1')).statusCode).toBe(201)

      const { statusCode, result } = await add(team, 'cs-limit-1')

      expect(statusCode).toBe(409)
      expect(result.code).toBe('credential-limit-reached')
      expect(await secretsOf(team)).toHaveLength(3)
    })

    test('audits the refusal at the limit, against the team', async () => {
      const team = await deployedTeam('cs-limit-2')

      await add(team, 'cs-limit-2')
      await add(team, 'cs-limit-2')
      await add(team, 'cs-limit-2')

      const events = await auditOf({
        action: 'credential.issue',
        resourceId: team.teamId,
        outcome: 'failure'
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        code: 'credential-limit-reached',
        role: 'admin'
      })
    })

    test('a revoked secret and an expired one free their places', async () => {
      const team = await deployedTeam('cs-limit-3')
      const first = await add(team, 'cs-limit-3')

      await add(team, 'cs-limit-3')
      expect((await add(team, 'cs-limit-3')).statusCode).toBe(409)

      const revoked = await server.inject({
        method: 'DELETE',
        url: `/v1/credentials/${first.result.credential.id}`,
        headers: fixtures.as('cs-limit-3')
      })

      expect(revoked.statusCode).toBe(204)
      expect((await add(team, 'cs-limit-3')).statusCode).toBe(201)
      expect((await add(team, 'cs-limit-3')).statusCode).toBe(409)

      await server.db
        .collection('credentials')
        .updateOne(
          { teamId: team.teamId, status: 'active', expiresAt: { $ne: null } },
          { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } }
        )

      expect((await add(team, 'cs-limit-3')).statusCode).toBe(201)
    })

    test('concurrent requests never hold more than three', async () => {
      const team = await deployedTeam('cs-limit-4')

      const results = await Promise.all(
        Array.from({ length: 5 }, () => add(team, 'cs-limit-4'))
      )

      expect(
        results.filter(({ statusCode }) => statusCode === 201)
      ).toHaveLength(2)
      expect(
        results.filter(({ statusCode }) => statusCode === 409)
      ).toHaveLength(3)
      expect(await secretsOf(team)).toHaveLength(3)
    })

    test('outside CLIENT_SECRET_ENVIRONMENTS: 409 client-secrets-not-allowed, nothing made, audited', async () => {
      const team = await deployedTeam('cs-allowed-1')
      const before = (await secretsOf(team)).length

      config.set('teamDeployment.clientSecretEnvironments', ['infradev'])

      const { statusCode, result } = await add(team, 'cs-allowed-1')

      expect(statusCode).toBe(409)
      expect(result.code).toBe('client-secrets-not-allowed')
      expect(await secretsOf(team)).toHaveLength(before)
      expect(
        await auditOf({
          action: 'credential.issue',
          resourceId: team.teamId,
          code: 'client-secrets-not-allowed'
        })
      ).toHaveLength(1)
    })

    test('an environment the team has not set up: 409 environment-not-set-up', async () => {
      const team = await fixtures.newTeam('cs-setup-1')

      const { statusCode, result } = await add(team, 'cs-setup-1')

      expect(statusCode).toBe(409)
      expect(result.code).toBe('environment-not-set-up')
      expect(await secretsOf(team)).toHaveLength(0)
    })

    test('an environment this instance does not offer: 404 environment-not-available', async () => {
      const team = await deployedTeam('cs-env-1')

      const { statusCode, result } = await add(team, 'cs-env-1', {
        environment: 'prod'
      })

      expect(statusCode).toBe(404)
      expect(result.code).toBe('environment-not-available')
    })

    test('a Member is refused 403 admin-required, audited, and nothing is made', async () => {
      const team = await deployedTeam('cs-role-1')

      await fixtures.addMember(team, 'cs-role-1-member')

      const before = (await secretsOf(team)).length
      const { statusCode, result } = await add(team, 'cs-role-1-member')

      expect(statusCode).toBe(403)
      expect(result.code).toBe('admin-required')
      expect(await secretsOf(team)).toHaveLength(before)
      expect(
        await auditOf({
          action: 'access.denied',
          resourceId: team.teamId,
          code: 'admin-required'
        })
      ).toHaveLength(1)
    })

    test("someone who is not in the team gets a plain 404, and a team's id or slug works alike", async () => {
      const team = await deployedTeam('cs-role-2')

      await fixtures.signIn('cs-role-2-outsider')

      const outsider = await add(team, 'cs-role-2-outsider')
      const byId = await server.inject({
        method: 'POST',
        url: `/v1/teams/${team.teamId}/environments/sandbox/client-secrets`,
        headers: {
          ...fixtures.as('cs-role-2'),
          'idempotency-key': randomUUID()
        }
      })

      expect(outsider.statusCode).toBe(404)
      expect(outsider.result.code).toBe('error')
      expect(byId.statusCode).toBe(201)
    })

    test('needs an Idempotency-Key (a UUID v4) and takes no body', async () => {
      const team = await deployedTeam('cs-valid-1')
      const url = `/v1/teams/${team.slug}/environments/sandbox/client-secrets`

      const missing = await server.inject({
        method: 'POST',
        url,
        headers: fixtures.as('cs-valid-1')
      })
      const body = await server.inject({
        method: 'POST',
        url,
        headers: {
          ...fixtures.as('cs-valid-1'),
          'idempotency-key': randomUUID()
        },
        payload: { modelSlug: 'gpt-4o' }
      })

      expect(missing.statusCode).toBe(400)
      expect(body.statusCode).toBe(400)
    })
  })

  describe('reveal, rotate and revoke of a team secret', () => {
    async function teamWithSecret(label) {
      const team = await deployedTeam(label)

      await fixtures.addMember(team, `${label}-member`)

      const { result } = await add(team, label)

      return { team, id: result.credential.id, secret: result.secret }
    }

    test('a Member is refused 403 admin-required on reveal, rotate and revoke, and nothing changes', async () => {
      const { id, secret } = await teamWithSecret('cs-rrr-1')
      const headers = fixtures.as('cs-rrr-1-member')

      const revealed = await server.inject({
        method: 'POST',
        url: `/v1/credentials/${id}/reveal`,
        headers,
        payload: { reason: 'I would like to see it' }
      })
      const rotated = await server.inject({
        method: 'POST',
        url: `/v1/credentials/${id}/rotate`,
        headers
      })
      const revoked = await server.inject({
        method: 'DELETE',
        url: `/v1/credentials/${id}`,
        headers
      })

      for (const response of [revealed, rotated, revoked]) {
        expect(response.statusCode).toBe(403)
        expect(response.result.code).toBe('admin-required')
        expect(response.payload).not.toContain(secret)
      }

      expect((await reveal(id, 'cs-rrr-1')).result.secret).toBe(secret)
    })

    test('an Admin reveals with a reason: the audit holds actor, credential and reason, never the value', async () => {
      const { id, secret } = await teamWithSecret('cs-rrr-2')

      const revealed = await reveal(id, 'cs-rrr-2')
      const events = await auditOf({
        action: 'credential.reveal',
        resourceId: id
      })

      expect(revealed.statusCode).toBe(200)
      expect(revealed.headers['cache-control']).toBe('no-store')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        role: 'admin',
        reason: 'Handing it to the application owner'
      })
      expect(JSON.stringify(events)).not.toContain(secret)
    })

    test('an Admin rotates: a new secret, never cached, and the old one no longer revealed', async () => {
      const { id, secret } = await teamWithSecret('cs-rrr-3')

      const rotated = await server.inject({
        method: 'POST',
        url: `/v1/credentials/${id}/rotate`,
        headers: fixtures.as('cs-rrr-3')
      })

      expect(rotated.statusCode).toBe(200)
      expect(rotated.headers['cache-control']).toBe('no-store')
      expect(rotated.result.secret).not.toBe(secret)
      expect((await reveal(id, 'cs-rrr-3')).result.secret).toBe(
        rotated.result.secret
      )
    })

    test('an Admin of another team cannot act on it: a plain 404', async () => {
      const { id } = await teamWithSecret('cs-rrr-4')
      const other = await fixtures.newTeam('cs-rrr-4-other')

      const response = await server.inject({
        method: 'DELETE',
        url: `/v1/credentials/${id}`,
        headers: fixtures.as(other.admin)
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe('the environment reads', () => {
    test('the summary says whether secrets are allowed and how many of the three are used; the detail lists them without a value', async () => {
      const team = await deployedTeam('cs-read-1')
      const { result: added } = await add(team, 'cs-read-1')

      const list = await server.inject({
        method: 'GET',
        url: `/v1/teams/${team.slug}/environments`,
        headers: fixtures.as('cs-read-1')
      })
      const detail = await server.inject({
        method: 'GET',
        url: `/v1/teams/${team.slug}/environments/sandbox`,
        headers: fixtures.as('cs-read-1')
      })
      const summary = list.result.environments.find(
        ({ environment }) => environment === 'sandbox'
      )

      expect(summary.clientSecrets).toEqual({
        allowed: true,
        used: 2,
        limit: 3
      })
      expect(detail.result.clientSecrets).toEqual({
        allowed: true,
        used: 2,
        limit: 3,
        items: [
          {
            id: expect.any(String),
            keyHint: expect.any(String),
            expiresAt: null,
            status: 'active'
          },
          {
            id: added.credential.id,
            keyHint: added.credential.keyHint,
            expiresAt: added.credential.expiresAt,
            status: 'active'
          }
        ]
      })
      expect(detail.payload).not.toContain(added.secret)
    })

    test('an expired secret is listed as expired and is not used; a revoked one is not listed', async () => {
      const team = await deployedTeam('cs-read-2')
      const expired = await add(team, 'cs-read-2')
      const revoked = await add(team, 'cs-read-2')

      await server.db
        .collection('credentials')
        .updateOne(
          { _id: new ObjectId(expired.result.credential.id) },
          { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } }
        )
      await server.inject({
        method: 'DELETE',
        url: `/v1/credentials/${revoked.result.credential.id}`,
        headers: fixtures.as('cs-read-2')
      })

      const { result } = await server.inject({
        method: 'GET',
        url: `/v1/teams/${team.slug}/environments/sandbox`,
        headers: fixtures.as('cs-read-2')
      })

      expect(result.clientSecrets.used).toBe(1)
      expect(
        result.clientSecrets.items.map(({ id, status }) => [id, status])
      ).toEqual([
        [expect.any(String), 'active'],
        [expired.result.credential.id, 'expired']
      ])
    })

    test('where secrets are not allowed the read says so, and a Member sees the same', async () => {
      const team = await deployedTeam('cs-read-3')

      await fixtures.addMember(team, 'cs-read-3-member')
      config.set('teamDeployment.clientSecretEnvironments', ['infradev'])

      const { result } = await server.inject({
        method: 'GET',
        url: `/v1/teams/${team.slug}/environments/sandbox`,
        headers: fixtures.as('cs-read-3-member')
      })

      expect(result.clientSecrets.allowed).toBe(false)
      expect(result.clientSecrets.limit).toBe(3)
    })
  })
})
