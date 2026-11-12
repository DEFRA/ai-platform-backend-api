import { randomUUID } from 'node:crypto'

import { withTestUsers } from '#/common/test-helpers/portal-token.js'
import { createTeamFixtures } from '#/common/test-helpers/team-fixtures.js'

const PRINCIPAL = '6F504113-6B64-43F2-ADE9-242E05780007'
const CDP = { host: 'cdp', service: 'beta-api', environments: ['sandbox'] }
const AZURE = {
  host: 'azure',
  principalId: PRINCIPAL,
  name: 'data-app',
  environments: ['sandbox']
}

let settleEvents

describe('#team-federations routes', () => {
  let server
  let fixtures
  let config
  let mockTeamFileReader
  let configuredEnvironments

  beforeAll(async () => {
    // A short mock stage so a change can run to its end within a test.
    vi.stubEnv('TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS', '30')

    const { createServer } = await import('#/server.js')

    ;({ config } = await import('#/config.js'))
    ;({ mockTeamFileReader } =
      await import('#/adapters/mock-team-file-reader.js'))
    server = await createServer()
    await server.initialize()
    withTestUsers(server)
    fixtures = createTeamFixtures(server)
    settleEvents = () => server.app.operations.transport.worker.idle()
    configuredEnvironments = config.get('teamDeployment.environments')
  })

  afterAll(async () => {
    await settleEvents()
    await server.stop({ timeout: 0 })
    vi.unstubAllEnvs()
  })

  afterEach(async () => {
    await settleEvents()
    // Another team trusting a workload refuses it, whichever test made it:
    // each test starts with no applications anywhere.
    await server.db
      .collection('teamDeployments')
      .updateMany({}, { $set: { federations: [] } })
    config.set('teamDeployment.environments', configuredEnvironments)
    vi.restoreAllMocks()
  })

  // A team with gpt-4o deployed in the Sandbox: its file is on `main` (as the
  // mock holds it), so the Sandbox is set up.
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

  function post(team, label, body, { key = randomUUID(), path = '' } = {}) {
    return server.inject({
      method: 'POST',
      url: `/v1/teams/${team.slug}/federations${path}`,
      headers: { ...fixtures.as(label), 'idempotency-key': key },
      payload: body
    })
  }

  function check(team, label, body) {
    return server.inject({
      method: 'POST',
      url: `/v1/teams/${team.slug}/federations/check`,
      headers: fixtures.as(label),
      payload: body
    })
  }

  function patch(
    team,
    label,
    id,
    body,
    { key = randomUUID(), environment = 'sandbox' } = {}
  ) {
    return server.inject({
      method: 'PATCH',
      url: `/v1/teams/${team.slug}/environments/${environment}/federations/${id}`,
      headers: { ...fixtures.as(label), 'idempotency-key': key },
      payload: body
    })
  }

  function remove(team, label, id, { environment = 'sandbox' } = {}) {
    return server.inject({
      method: 'DELETE',
      url: `/v1/teams/${team.slug}/environments/${environment}/federations/${id}`,
      headers: fixtures.as(label)
    })
  }

  async function entriesOf(team, environment = 'sandbox') {
    const doc = await server.db
      .collection('teamDeployments')
      .findOne({ teamId: team.teamId, environment })

    return doc?.federations ?? []
  }

  function operationsOf(team) {
    return server.db
      .collection('operations')
      .find({ teamId: team.teamId, 'items.kind': 'federation' })
      .sort({ createdAt: 1 })
      .toArray()
  }

  async function fileOf(team, environment = 'sandbox') {
    const { document } = await mockTeamFileReader.getCurrentDocument({
      path: `environments/${environment}/${team.slug}.json`
    })

    return document
  }

  // The team's own audit events: those against the team, and against its
  // applications.
  async function auditOf(team, filter) {
    const ids = await server.db
      .collection('teamDeployments')
      .find({ teamId: team.teamId })
      .toArray()

    return server.db
      .collection('auditEvents')
      .find({
        ...filter,
        resourceId: {
          $in: [
            team.teamId,
            ...ids.flatMap(({ federations }) =>
              (federations ?? []).map(({ id }) => id)
            )
          ]
        }
      })
      .toArray()
  }

  // An application already in the team's registration, as the projection keeps it.
  async function seedEntries(team, environment, entries) {
    await server.db.collection('teamDeployments').updateOne(
      { teamId: team.teamId, environment },
      {
        $push: {
          federations: {
            $each: entries.map((entry, index) => ({
              id: `seed-${team.teamId}-${environment}-${index}`,
              host: 'cdp',
              statusTimes: {},
              operationId: null,
              failureReason: null,
              status: 'ready',
              ...entry,
              trustKey: `CDP service ${entry.service}`
            }))
          }
        },
        $setOnInsert: { teamId: team.teamId, environment, deployments: [] }
      },
      { upsert: true }
    )
  }

  describe('POST /v1/teams/{teamId}/federations', () => {
    test('queues one operation for a CDP application, and once it is applied the file holds only its name, host and service', async () => {
      const team = await deployedTeam('fed-cdp-1')
      const before = await fileOf(team)
      const { statusCode, result } = await post(team, 'fed-cdp-1', CDP)

      expect(statusCode).toBe(202)
      expect(result.federations).toEqual([
        {
          environment: 'sandbox',
          id: expect.any(String),
          status: 'setting-up',
          operationId: expect.any(String)
        }
      ])

      await settleEvents()

      const [operation] = await operationsOf(team)
      const file = await fileOf(team)

      expect(operation).toMatchObject({
        state: 'active',
        items: [
          {
            kind: 'federation',
            change: 'add',
            name: 'beta-api',
            federation: { host: 'cdp', name: 'beta-api', service: 'beta-api' }
          }
        ]
      })
      expect(file.oauth.federations).toEqual([
        { name: 'beta-api', host: 'cdp', service: 'beta-api' }
      ])
      expect(file.revision).toBe(before.revision + 1)
      expect(file.deployments).toEqual(before.deployments)
      expect(file.gateway).toEqual(before.gateway)
      expect(await entriesOf(team)).toMatchObject([
        { name: 'beta-api', host: 'cdp', service: 'beta-api', status: 'ready' }
      ])
    })

    test('lets a Member federate, and shows the application on the environment page with a place used', async () => {
      const team = await deployedTeam('fed-cdp-2')

      await fixtures.addMember(team, 'fed-cdp-2-member')

      const { statusCode } = await post(team, 'fed-cdp-2-member', CDP)

      await settleEvents()

      const read = await server.inject({
        method: 'GET',
        url: `/v1/teams/${team.slug}/environments/sandbox`,
        headers: fixtures.as('fed-cdp-2-member')
      })

      expect(statusCode).toBe(202)
      expect(read.result.applications).toMatchObject({
        used: 1,
        limit: 20,
        items: [
          {
            name: 'beta-api',
            host: 'cdp',
            service: 'beta-api',
            status: 'ready'
          }
        ]
      })
      expect(read.result.latestOperation).toMatchObject({
        kind: 'federation',
        changes: [
          {
            kind: 'federation',
            change: 'add',
            application: { name: 'beta-api', host: 'cdp', service: 'beta-api' }
          }
        ]
      })
    })

    test('writes an Azure application with the Defra tenant’s issuer and the principal ID, in lower case, as subject', async () => {
      const team = await deployedTeam('fed-azure-1')
      const { defraIssuer } =
        await import('#/services/team-federation-entries.js')
      const { statusCode } = await post(team, 'fed-azure-1', AZURE)

      await settleEvents()

      expect(statusCode).toBe(202)
      expect((await fileOf(team)).oauth.federations).toEqual([
        {
          name: 'data-app',
          host: 'azure',
          issuer: defraIssuer(),
          subject: PRINCIPAL.toLowerCase()
        }
      ])
      expect(await entriesOf(team)).toMatchObject([
        {
          host: 'azure',
          name: 'data-app',
          principalId: PRINCIPAL.toLowerCase()
        }
      ])
    })

    test('makes one operation and one application for each environment, under the key and the environment', async () => {
      const team = await deployedTeam('fed-multi-1')
      const key = randomUUID()

      withInfradev(team)

      const { statusCode, result } = await post(
        team,
        'fed-multi-1',
        { ...CDP, environments: ['sandbox', 'infradev'] },
        { key }
      )

      expect(statusCode).toBe(202)
      expect(result.federations.map(({ environment }) => environment)).toEqual([
        'sandbox',
        'infradev'
      ])
      expect(new Set(result.federations.map(({ id }) => id)).size).toBe(2)

      const operations = await operationsOf(team)

      expect(operations.map(({ environment }) => environment)).toEqual([
        'sandbox',
        'infradev'
      ])
      expect(operations.map(({ idempotencyKeys }) => idempotencyKeys)).toEqual([
        [`${key}:sandbox`],
        [`${key}:infradev`]
      ])
      expect(await entriesOf(team, 'infradev')).toHaveLength(1)
    })

    test('replays a repeated key: 200, the same applications, nothing queued twice', async () => {
      const team = await deployedTeam('fed-replay-1')
      const key = randomUUID()
      const first = await post(team, 'fed-replay-1', CDP, { key })

      await settleEvents()

      // The application is ready and holds its place, so asking again would be
      // refused as already federated: the replay answers before that.
      const again = await post(team, 'fed-replay-1', CDP, { key })

      expect(again.statusCode).toBe(200)
      expect(again.result.federations[0]).toMatchObject({
        id: first.result.federations[0].id,
        operationId: first.result.federations[0].operationId,
        status: 'ready'
      })
      expect(await operationsOf(team)).toHaveLength(1)
      expect(await entriesOf(team)).toHaveLength(1)
    })

    test('completes a partial retry: the done environment replays and the rest are made', async () => {
      const team = await deployedTeam('fed-partial-1')
      const key = randomUUID()

      withInfradev(team)

      const first = await post(team, 'fed-partial-1', CDP, { key })
      const retry = await post(
        team,
        'fed-partial-1',
        { ...CDP, environments: ['sandbox', 'infradev'] },
        { key }
      )

      expect(first.statusCode).toBe(202)
      expect(retry.statusCode).toBe(202)
      expect(retry.result.federations[0].id).toBe(
        first.result.federations[0].id
      )
      expect(await operationsOf(team)).toHaveLength(2)
      expect(await entriesOf(team, 'sandbox')).toHaveLength(1)
      expect(await entriesOf(team, 'infradev')).toHaveLength(1)
    })

    test('refuses a key made for another application', async () => {
      const team = await deployedTeam('fed-reuse-1')
      const key = randomUUID()

      await post(team, 'fed-reuse-1', CDP, { key })

      const other = await post(
        team,
        'fed-reuse-1',
        { ...CDP, service: 'gamma-api' },
        { key }
      )

      expect(other.statusCode).toBe(409)
      expect(other.result.code).toBe('idempotency-key-reused')
      expect(await operationsOf(team)).toHaveLength(1)
    })

    test('marks a name containing mock-checks-failed as failing its checks, under the mock only, leaving the file as it was', async () => {
      const team = await deployedTeam('fed-mock-1')
      const before = await fileOf(team)

      await post(team, 'fed-mock-1', { ...CDP, service: 'mock-checks-failed' })
      await settleEvents()

      const [operation] = await operationsOf(team)

      expect(operation.state).toBe('checks-failed')
      expect(await entriesOf(team)).toMatchObject([
        {
          name: 'mock-checks-failed',
          status: 'failed',
          failureReason: expect.stringContaining('checks failed')
        }
      ])
      expect(await fileOf(team)).toEqual(before)
    })

    test('marks a name containing mock-deploy-failed as failing its deploy', async () => {
      const team = await deployedTeam('fed-mock-2')

      await post(team, 'fed-mock-2', {
        ...AZURE,
        name: 'team-mock-deploy-failed'
      })
      await settleEvents()

      const [operation] = await operationsOf(team)

      expect(operation.state).toBe('deploy-failed')
      expect((await entriesOf(team))[0].status).toBe('failed')
    })

    test('shows an ordinary name as it is, with no forced outcome', async () => {
      const team = await deployedTeam('fed-mock-3')

      await post(team, 'fed-mock-3', CDP)

      const [operation] = await operationsOf(team)

      expect(operation).not.toHaveProperty('mockOutcome')
    })

    describe('what it refuses, naming the environment and queuing nothing', () => {
      test('an environment this instance does not offer, and one the team has not set up', async () => {
        const team = await deployedTeam('fed-refuse-1')

        config.set('teamDeployment.environments', ['sandbox', 'infradev'])

        const { statusCode, result } = await post(team, 'fed-refuse-1', {
          ...CDP,
          environments: ['sandbox', 'infradev', 'prod']
        })

        expect(statusCode).toBe(409)
        expect(result.code).toBe('federation-refused')
        expect(result.environments).toEqual([
          { environment: 'infradev', code: 'environment-not-set-up' },
          { environment: 'prod', code: 'environment-not-available' }
        ])
        expect(await operationsOf(team)).toEqual([])
        expect(await entriesOf(team)).toEqual([])
      })

      test('an application the team already federates there, by service or by name', async () => {
        const team = await deployedTeam('fed-refuse-2')

        await post(team, 'fed-refuse-2', CDP)

        const again = await post(team, 'fed-refuse-2', CDP)
        const sameName = await post(team, 'fed-refuse-2', {
          ...AZURE,
          name: 'beta-api'
        })

        expect(again.statusCode).toBe(409)
        expect(again.result.environments).toEqual([
          { environment: 'sandbox', code: 'federation-exists' }
        ])
        expect(sameName.result.environments).toEqual([
          { environment: 'sandbox', code: 'federation-exists' }
        ])
      })

      test('a workload another team trusts in that environment, without naming the other team', async () => {
        const team = await deployedTeam('fed-refuse-3')
        const other = await fixtures.newTeam('fed-refuse-3-other-team')

        await seedEntries(other, 'sandbox', [
          { name: 'shared-api', service: 'shared-api', status: 'ready' }
        ])

        const { statusCode, result } = await post(team, 'fed-refuse-3', {
          ...CDP,
          service: 'shared-api'
        })

        expect(statusCode).toBe(409)
        expect(result.environments).toEqual([
          { environment: 'sandbox', code: 'federation-trusted-elsewhere' }
        ])
        expect(JSON.stringify(result)).not.toMatch(
          new RegExp(`${other.slug}|${other.teamId}|other-team`)
        )
      })

      test('does not count a failed or removed application of another team as trusting the workload', async () => {
        const team = await deployedTeam('fed-refuse-4')
        const other = await fixtures.newTeam('fed-refuse-4-other')

        await seedEntries(other, 'sandbox', [
          { name: 'old-api', service: 'old-api', status: 'failed' },
          { name: 'gone-api', service: 'gone-api', status: 'removed' }
        ])

        const failed = await post(team, 'fed-refuse-4', {
          ...CDP,
          service: 'old-api'
        })
        const removed = await post(team, 'fed-refuse-4', {
          ...CDP,
          service: 'gone-api'
        })

        expect(failed.statusCode).toBe(202)
        expect(removed.statusCode).toBe(202)
      })

      test('a registration that holds 20, at 21, while another environment with room is accepted', async () => {
        const team = await deployedTeam('fed-refuse-5')

        await seedEntries(
          team,
          'sandbox',
          Array.from({ length: 20 }, (_, index) => ({
            name: `app-${index}`,
            service: `app-${index}`
          }))
        )

        const full = await post(team, 'fed-refuse-5', CDP)

        expect(full.statusCode).toBe(409)
        expect(full.result.environments).toEqual([
          { environment: 'sandbox', code: 'federation-limit-reached' }
        ])

        withInfradev(team)

        const roomy = await post(team, 'fed-refuse-5', {
          ...CDP,
          environments: ['infradev']
        })
        const mixed = await post(team, 'fed-refuse-5', {
          ...CDP,
          service: 'gamma-api',
          environments: ['sandbox', 'infradev']
        })

        expect(roomy.statusCode).toBe(202)
        // All or nothing: Infradev has room, but the Sandbox does not.
        expect(mixed.statusCode).toBe(409)
        expect(await entriesOf(team, 'infradev')).toHaveLength(1)
      })

      test('does not count failed or removed applications against the 20', async () => {
        const team = await deployedTeam('fed-refuse-6')

        await seedEntries(
          team,
          'sandbox',
          Array.from({ length: 20 }, (_, index) => ({
            name: `app-${index}`,
            service: `app-${index}`,
            status: index === 0 ? 'failed' : index === 1 ? 'removed' : 'ready'
          }))
        )

        const { statusCode } = await post(team, 'fed-refuse-6', CDP)

        expect(statusCode).toBe(202)
      })

      test('audits each refusal against the team, with its code, and queues no operation', async () => {
        const team = await deployedTeam('fed-refuse-7')

        await post(team, 'fed-refuse-7', CDP)
        await post(team, 'fed-refuse-7', CDP)

        expect(
          await auditOf(team, {
            action: 'teamFederation.request',
            outcome: 'failure',
            code: 'federation-exists'
          })
        ).toHaveLength(1)
        expect(await operationsOf(team)).toHaveLength(1)
      })
    })

    test('audits what it did, as the person, with no secret in it', async () => {
      const team = await deployedTeam('fed-audit-1')
      const key = randomUUID()

      await post(team, 'fed-audit-1', CDP, { key })

      const events = await auditOf(team, {
        action: 'teamFederation.request',
        outcome: 'success'
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        resource: 'teamFederation',
        role: 'admin',
        reason: 'sandbox'
      })
      expect(JSON.stringify(events)).not.toContain(key)
    })

    test.each([
      [
        'a CDP application with no service',
        { host: 'cdp', environments: ['sandbox'] }
      ],
      ['a CDP application with a name', { ...CDP, name: 'beta-api' }],
      ['a CDP service that is not a name', { ...CDP, service: 'Beta API' }],
      ['a CDP service over 32 characters', { ...CDP, service: 'a'.repeat(33) }],
      [
        'an Azure application with no name',
        { host: 'azure', principalId: PRINCIPAL, environments: ['sandbox'] }
      ],
      [
        'an Azure application with no principal ID',
        { host: 'azure', name: 'data-app', environments: ['sandbox'] }
      ],
      [
        'an Azure principal ID that is not a GUID',
        { ...AZURE, principalId: 'not-a-guid' }
      ],
      [
        'an Azure application with a service',
        { ...AZURE, service: 'beta-api' }
      ],
      ['an unknown host', { ...CDP, host: 'aws' }],
      ['no environments', { ...CDP, environments: [] }],
      [
        'six environments',
        { ...CDP, environments: ['a1', 'b1', 'c1', 'd1', 'e1', 'f1'] }
      ],
      [
        'a repeated environment',
        { ...CDP, environments: ['sandbox', 'sandbox'] }
      ],
      [
        'an environment that is not a name',
        { ...CDP, environments: ['Sand Box'] }
      ],
      ['an unknown key', { ...CDP, extra: 1 }]
    ])('refuses %s as a bad request', async (_name, body) => {
      const team = await fixtures.newTeam(`fed-bad-${randomUUID().slice(0, 8)}`)
      const { statusCode } = await post(team, team.admin, body)

      expect(statusCode).toBe(400)
    })

    test.each([
      ['no key', undefined],
      ['a key that is not a UUID', 'abc']
    ])('refuses %s', async (_name, key) => {
      const team = await fixtures.newTeam(`fed-key-${randomUUID().slice(0, 8)}`)
      const { statusCode } = await server.inject({
        method: 'POST',
        url: `/v1/teams/${team.slug}/federations`,
        headers: {
          ...fixtures.as(team.admin),
          ...(key ? { 'idempotency-key': key } : {})
        },
        payload: CDP
      })

      expect(statusCode).toBe(400)
    })

    test('is not found for someone outside the team, audited, and queues nothing; a team that does not exist is not found', async () => {
      const team = await deployedTeam('fed-outsider-1')

      await fixtures.signIn('fed-outsider-1-stranger')

      const stranger = await post(team, 'fed-outsider-1-stranger', CDP)
      const nobody = await server.inject({
        method: 'POST',
        url: '/v1/teams/no-such-team/federations',
        headers: {
          ...fixtures.as('fed-outsider-1-stranger'),
          'idempotency-key': randomUUID()
        },
        payload: CDP
      })

      expect(stranger.statusCode).toBe(404)
      expect(nobody.statusCode).toBe(404)
      expect(await operationsOf(team)).toEqual([])
      expect(
        await auditOf(team, { action: 'access.denied', code: 'not-a-member' })
      ).toHaveLength(1)
    })

    test('needs a signed-in person', async () => {
      const team = await fixtures.newTeam('fed-anon-1')
      const { statusCode } = await server.inject({
        method: 'POST',
        url: `/v1/teams/${team.slug}/federations`,
        headers: { 'idempotency-key': randomUUID() },
        payload: CDP
      })

      expect(statusCode).toBe(401)
    })

    test('is refused as upstream-unavailable, with nothing left recorded, when the operation cannot be queued', async () => {
      const team = await deployedTeam('fed-fail-1')

      vi.spyOn(server.app.operations.operations, 'request').mockRejectedValue(
        new Error('the database is down')
      )

      const { statusCode, result } = await post(team, 'fed-fail-1', CDP)

      expect(statusCode).toBe(502)
      expect(result.code).toBe('upstream-unavailable')
      expect(await entriesOf(team)).toEqual([])
      expect(
        await auditOf(team, {
          action: 'teamFederation.request',
          outcome: 'failure',
          code: 'upstream-unavailable'
        })
      ).toHaveLength(1)
    })
  })

  describe('POST /v1/teams/{teamId}/federations/check', () => {
    test('says per environment what would be refused, in the order asked, and changes nothing', async () => {
      const team = await deployedTeam('fed-check-1')

      await post(team, 'fed-check-1', CDP)
      await settleEvents()
      config.set('teamDeployment.environments', ['sandbox', 'infradev'])

      const operations = await operationsOf(team)
      const { statusCode, result } = await check(team, 'fed-check-1', {
        ...CDP,
        environments: ['infradev', 'sandbox', 'prod']
      })

      expect(statusCode).toBe(200)
      expect(result.environments).toEqual([
        { environment: 'infradev', code: 'environment-not-set-up' },
        { environment: 'sandbox', code: 'federation-exists' },
        { environment: 'prod', code: 'environment-not-available' }
      ])
      expect(await operationsOf(team)).toHaveLength(operations.length)
      expect(await entriesOf(team)).toHaveLength(1)
    })

    test('answers null for an environment the application could be federated in, to a Member', async () => {
      const team = await deployedTeam('fed-check-2')

      await fixtures.addMember(team, 'fed-check-2-member')

      const { statusCode, result } = await check(
        team,
        'fed-check-2-member',
        CDP
      )

      expect(statusCode).toBe(200)
      expect(result.environments).toEqual([
        { environment: 'sandbox', code: null }
      ])
    })

    test('reports a trusted-elsewhere workload and a full registration, without naming another team', async () => {
      const team = await deployedTeam('fed-check-3')
      const other = await fixtures.newTeam('fed-check-3-other')

      await seedEntries(other, 'sandbox', [
        { name: 'shared-api', service: 'shared-api' }
      ])

      const elsewhere = await check(team, 'fed-check-3', {
        ...CDP,
        service: 'shared-api'
      })

      expect(elsewhere.result.environments).toEqual([
        { environment: 'sandbox', code: 'federation-trusted-elsewhere' }
      ])
      expect(JSON.stringify(elsewhere.result)).not.toContain(other.slug)
    })

    test('is not found for someone outside the team, and a bad request for a body that is not a request', async () => {
      const team = await deployedTeam('fed-check-4')

      await fixtures.signIn('fed-check-4-stranger')

      const stranger = await check(team, 'fed-check-4-stranger', CDP)
      const bad = await check(team, 'fed-check-4', { host: 'cdp' })

      expect(stranger.statusCode).toBe(404)
      expect(bad.statusCode).toBe(400)
    })
  })

  describe('PATCH /v1/teams/{teamId}/environments/{environment}/federations/{id}', () => {
    async function readyApplication(label, request = CDP) {
      const team = await deployedTeam(label)
      const { result } = await post(team, label, request)

      await settleEvents()

      return { team, id: result.federations[0].id }
    }

    test('lets an Admin change a CDP application, replacing its entry in the file by name and keeping the rest', async () => {
      const { team, id } = await readyApplication('fed-patch-1')

      await post(team, 'fed-patch-1', { ...CDP, service: 'gamma-api' })
      await settleEvents()

      const { statusCode, result } = await patch(team, 'fed-patch-1', id, {
        service: 'delta-api'
      })

      expect(statusCode).toBe(202)
      expect(result.federation).toMatchObject({
        id,
        name: 'delta-api',
        host: 'cdp',
        service: 'delta-api',
        status: 'setting-up'
      })
      expect(result.operationId).toEqual(expect.any(String))

      await settleEvents()

      expect((await fileOf(team)).oauth.federations).toEqual([
        { name: 'delta-api', host: 'cdp', service: 'delta-api' },
        { name: 'gamma-api', host: 'cdp', service: 'gamma-api' }
      ])
      expect(
        (await entriesOf(team)).find((entry) => entry.id === id)
      ).toMatchObject({
        name: 'delta-api',
        service: 'delta-api',
        status: 'ready'
      })
    })

    test('changes an Azure application’s principal ID and name', async () => {
      const { team, id } = await readyApplication('fed-patch-2', AZURE)
      const { statusCode } = await patch(team, 'fed-patch-2', id, {
        principalId: '11111111-1111-4111-8111-111111111111',
        name: 'renamed-app'
      })

      await settleEvents()

      expect(statusCode).toBe(202)
      expect((await fileOf(team)).oauth.federations).toEqual([
        expect.objectContaining({
          name: 'renamed-app',
          subject: '11111111-1111-4111-8111-111111111111'
        })
      ])
    })

    test('replays a repeated key: 200, one operation', async () => {
      const { team, id } = await readyApplication('fed-patch-3')
      const key = randomUUID()
      const first = await patch(
        team,
        'fed-patch-3',
        id,
        { service: 'delta-api' },
        { key }
      )

      await settleEvents()

      const again = await patch(
        team,
        'fed-patch-3',
        id,
        { service: 'delta-api' },
        { key }
      )
      const other = await patch(
        team,
        'fed-patch-3',
        id,
        { service: 'zeta-api' },
        { key }
      )

      expect(first.statusCode).toBe(202)
      expect(again.statusCode).toBe(200)
      expect(again.result.operationId).toBe(first.result.operationId)
      expect(other.statusCode).toBe(409)
      expect(other.result.code).toBe('idempotency-key-reused')
      expect(await operationsOf(team)).toHaveLength(2)
    })

    test.each([
      ['an application the team already has', 'gamma-api', 'federation-exists'],
      ['the application as it is', 'beta-api', 'federation-unchanged']
    ])('refuses a change to %s', async (_name, service, code) => {
      const { team, id } = await readyApplication(`fed-patch-${code}`)

      await post(team, `fed-patch-${code}`, { ...CDP, service: 'gamma-api' })
      await settleEvents()

      const { statusCode, result } = await patch(
        team,
        `fed-patch-${code}`,
        id,
        {
          service
        }
      )

      expect(statusCode).toBe(409)
      expect(result.code).toBe(code)
    })

    test('refuses a change to a workload another team trusts, without naming it', async () => {
      const { team, id } = await readyApplication('fed-patch-4')
      const other = await fixtures.newTeam('fed-patch-4-other')

      await seedEntries(other, 'sandbox', [
        { name: 'shared-api', service: 'shared-api' }
      ])

      const { statusCode, result } = await patch(team, 'fed-patch-4', id, {
        service: 'shared-api'
      })

      expect(statusCode).toBe(409)
      expect(result.code).toBe('federation-trusted-elsewhere')
      expect(JSON.stringify(result)).not.toContain(other.slug)
    })

    test('accepts a change in a registration that holds 20', async () => {
      const { team, id } = await readyApplication('fed-patch-5')

      await seedEntries(
        team,
        'sandbox',
        Array.from({ length: 19 }, (_, index) => ({
          name: `app-${index}`,
          service: `app-${index}`
        }))
      )

      const { statusCode } = await patch(team, 'fed-patch-5', id, {
        service: 'delta-api'
      })

      expect(statusCode).toBe(202)
    })

    test('refuses a change while the application is being set up or removed', async () => {
      const team = await deployedTeam('fed-patch-6')

      await seedEntries(team, 'sandbox', [
        { name: 'one-api', service: 'one-api', status: 'setting-up' },
        { name: 'two-api', service: 'two-api', status: 'removing' }
      ])

      const settingUp = await patch(
        team,
        'fed-patch-6',
        `seed-${team.teamId}-sandbox-0`,
        {
          service: 'delta-api'
        }
      )
      const removing = await patch(
        team,
        'fed-patch-6',
        `seed-${team.teamId}-sandbox-1`,
        {
          service: 'delta-api'
        }
      )

      expect(settingUp.statusCode).toBe(409)
      expect(settingUp.result.code).toBe('federation-in-progress')
      expect(removing.result.code).toBe('federation-in-progress')
    })

    test.each([
      ['a service for an Azure application', AZURE, { service: 'beta-api' }],
      [
        'a principal ID and name for a CDP application',
        CDP,
        { principalId: PRINCIPAL, name: 'x-app' }
      ]
    ])('refuses %s as the other host’s', async (_name, request, body) => {
      const label = `fed-patch-host-${randomUUID().slice(0, 6)}`
      const { team, id } = await readyApplication(label, request)
      const { statusCode, result } = await patch(team, label, id, body)

      expect(statusCode).toBe(400)
      expect(result.code).toBe('federation-host-mismatch')
    })

    test.each([['nothing'], ['a service and a name'], ['an unknown key']])(
      'refuses %s as a bad request',
      async (name) => {
        const { team, id } = await readyApplication(
          `fed-patch-body-${randomUUID().slice(0, 6)}`
        )
        const bodies = {
          nothing: {},
          'a service and a name': { service: 'a-api', name: 'a-app' },
          'an unknown key': { service: 'a-api', extra: 1 }
        }
        const { statusCode } = await patch(team, team.admin, id, bodies[name])

        expect(statusCode).toBe(400)
      }
    )

    test('is refused to a Member as admin-required, audited, and nothing is queued', async () => {
      const { team, id } = await readyApplication('fed-patch-7')

      await fixtures.addMember(team, 'fed-patch-7-member')

      const { statusCode, result } = await patch(
        team,
        'fed-patch-7-member',
        id,
        {
          service: 'delta-api'
        }
      )

      expect(statusCode).toBe(403)
      expect(result.code).toBe('admin-required')
      expect(await operationsOf(team)).toHaveLength(1)
      expect(
        await auditOf(team, { action: 'access.denied', code: 'admin-required' })
      ).toHaveLength(1)
    })

    test('is not found for another team’s application, an unknown one, an environment not offered, and a stranger', async () => {
      const { team, id } = await readyApplication('fed-patch-8')
      const other = await deployedTeam('fed-patch-8-other')

      await fixtures.signIn('fed-patch-8-stranger')

      const foreign = await patch(other, 'fed-patch-8-other', id, {
        service: 'delta-api'
      })
      const unknown = await patch(team, 'fed-patch-8', 'no-such-id', {
        service: 'delta-api'
      })
      const elsewhere = await patch(
        team,
        'fed-patch-8',
        id,
        { service: 'delta-api' },
        { environment: 'prod' }
      )
      const stranger = await patch(team, 'fed-patch-8-stranger', id, {
        service: 'delta-api'
      })

      expect(foreign.statusCode).toBe(404)
      expect(unknown.statusCode).toBe(404)
      expect(elsewhere.statusCode).toBe(404)
      expect(elsewhere.result.code).toBe('environment-not-available')
      expect(stranger.statusCode).toBe(404)
    })

    test('audits the change', async () => {
      const { team, id } = await readyApplication('fed-patch-9')

      await patch(team, 'fed-patch-9', id, { service: 'delta-api' })

      expect(
        await auditOf(team, {
          action: 'teamFederation.change',
          outcome: 'success'
        })
      ).toHaveLength(1)
    })
  })

  describe('DELETE /v1/teams/{teamId}/environments/{environment}/federations/{id}', () => {
    async function readyApplication(label) {
      const team = await deployedTeam(label)
      const { result } = await post(team, label, CDP)

      await settleEvents()

      return { team, id: result.federations[0].id }
    }

    test('lets an Admin remove an application: removing at once, then removed, gone from the file, its place freed', async () => {
      const { team, id } = await readyApplication('fed-del-1')

      await post(team, 'fed-del-1', { ...CDP, service: 'gamma-api' })
      await settleEvents()

      const { statusCode, result } = await remove(team, 'fed-del-1', id)

      expect(statusCode).toBe(202)
      expect(result.federation).toMatchObject({ id, status: 'removing' })

      await settleEvents()

      const done = await remove(team, 'fed-del-1', id)

      expect(done.statusCode).toBe(200)
      expect(done.result.federation).toMatchObject({ id, status: 'removed' })
      expect((await fileOf(team)).oauth.federations).toEqual([
        { name: 'gamma-api', host: 'cdp', service: 'gamma-api' }
      ])

      const read = await server.inject({
        method: 'GET',
        url: `/v1/teams/${team.slug}/environments/sandbox`,
        headers: fixtures.as('fed-del-1')
      })

      expect(read.result.applications.used).toBe(1)
      expect(
        read.result.applications.items.map(({ id: item }) => item)
      ).not.toContain(id)
      // The place is free: the same application can be federated again.
      expect((await post(team, 'fed-del-1', CDP)).statusCode).toBe(202)
    })

    test('answers a removal already under way as it is, without a second operation', async () => {
      const team = await deployedTeam('fed-del-2')

      await seedEntries(team, 'sandbox', [
        { name: 'one-api', service: 'one-api', status: 'removing' }
      ])

      const { statusCode, result } = await remove(
        team,
        'fed-del-2',
        `seed-${team.teamId}-sandbox-0`
      )

      expect(statusCode).toBe(202)
      expect(result.federation.status).toBe('removing')
      expect(await operationsOf(team)).toEqual([])
    })

    test('refuses a removal while the application is being set up', async () => {
      const team = await deployedTeam('fed-del-3')

      await seedEntries(team, 'sandbox', [
        { name: 'one-api', service: 'one-api', status: 'setting-up' }
      ])

      const { statusCode, result } = await remove(
        team,
        'fed-del-3',
        `seed-${team.teamId}-sandbox-0`
      )

      expect(statusCode).toBe(409)
      expect(result.code).toBe('federation-in-progress')
    })

    test('removes an application that failed, leaving the file as it was', async () => {
      const team = await deployedTeam('fed-del-4')

      await post(team, 'fed-del-4', { ...CDP, service: 'mock-checks-failed' })
      await settleEvents()

      const [entry] = await entriesOf(team)
      const { statusCode } = await remove(team, 'fed-del-4', entry.id)

      await settleEvents()

      expect(statusCode).toBe(202)
      expect((await entriesOf(team))[0].status).toBe('removed')
    })

    test('is refused to a Member as admin-required, audited, and nothing is queued', async () => {
      const { team, id } = await readyApplication('fed-del-5')

      await fixtures.addMember(team, 'fed-del-5-member')

      const { statusCode, result } = await remove(team, 'fed-del-5-member', id)

      expect(statusCode).toBe(403)
      expect(result.code).toBe('admin-required')
      expect(await operationsOf(team)).toHaveLength(1)
    })

    test('is not found for another team’s application, an unknown one, and a stranger', async () => {
      const { team, id } = await readyApplication('fed-del-6')
      const other = await deployedTeam('fed-del-6-other')

      await fixtures.signIn('fed-del-6-stranger')

      expect((await remove(other, 'fed-del-6-other', id)).statusCode).toBe(404)
      expect((await remove(team, 'fed-del-6', 'no-such-id')).statusCode).toBe(
        404
      )
      expect((await remove(team, 'fed-del-6-stranger', id)).statusCode).toBe(
        404
      )
    })

    test('audits the removal', async () => {
      const { team, id } = await readyApplication('fed-del-7')

      await remove(team, 'fed-del-7', id)

      expect(
        await auditOf(team, {
          action: 'teamFederation.remove',
          outcome: 'success'
        })
      ).toHaveLength(1)
    })

    test('is refused as upstream-unavailable, leaving the application as it was, when the operation cannot be queued', async () => {
      const { team, id } = await readyApplication('fed-del-8')

      vi.spyOn(server.app.operations.operations, 'request').mockRejectedValue(
        new Error('the database is down')
      )

      const { statusCode, result } = await remove(team, 'fed-del-8', id)

      expect(statusCode).toBe(502)
      expect(result.code).toBe('upstream-unavailable')
      expect((await entriesOf(team))[0].status).toBe('ready')
    })
  })
})
