import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

import { actorFor } from '#/common/test-helpers/portal-token.js'

const ENVIRONMENTS = ['dept-dev', 'dept-test']
const DEV = ENVIRONMENTS[0]
const TEST = ENVIRONMENTS[1]
const ADMIN = actorFor('deployments-admin', { isPlatformAdmin: true })
const TEAM_ADMIN = actorFor('deployments-team-admin')

describe('#admin-deployment-service', () => {
  let server
  let db
  let config
  let service
  let block
  let configured

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    ;({ config } = await import('#/config.js'))
    configured = config.get('teamDeployment.environments')
    config.set('teamDeployment.environments', ENVIRONMENTS)
    server = await createServer()
    await server.initialize()
    db = server.db
    service = await import('#/services/admin-deployment-service.js')
    block = await import('#/services/credential-block.js')
    await db.collection('models').insertMany([
      { slug: 'dep-gpt', displayName: 'Dep GPT' },
      { slug: 'dep-claude', displayName: 'Dep Claude' }
    ])
  })

  afterAll(async () => {
    await db.collection('models').deleteMany({ slug: /^dep-/ })
    config.set('teamDeployment.environments', configured)
    await server.stop({ timeout: 0 })
  })

  beforeEach(async () => {
    await Promise.all(
      [
        'teamDeployments',
        'teams',
        'teamMembers',
        'credentials',
        'operations'
      ].map((name) => db.collection(name).deleteMany({}))
    )
    await db.collection('auditEvents').deleteMany({})
    const { invalidateModelsCache } =
      await import('#/services/models-service.js')

    invalidateModelsCache()
  })

  async function team(name, fields = {}) {
    const { insertedId } = await db.collection('teams').insertOne({
      name,
      normalisedName: name.toLowerCase().replaceAll(/\s+/g, '-'),
      slug: name.toLowerCase().replaceAll(/\s+/g, '-'),
      ...fields
    })

    return insertedId.toString()
  }

  function entry(fields = {}) {
    return {
      id: randomUUID(),
      modelSlug: 'dep-gpt',
      status: 'active',
      createdAt: '2026-10-30T10:00:00.000Z',
      statusTimes: { active: '2026-10-30T11:00:00.000Z' },
      ...fields
    }
  }

  async function deployment(teamId, environment, entries, fields = {}) {
    const doc = {
      teamId,
      environment,
      deployments: entries,
      ...fields
    }

    await db.collection('teamDeployments').insertOne(doc)

    return doc
  }

  function credentialOf(teamId, environment, fields = {}) {
    return db.collection('credentials').insertOne({
      teamId,
      environment,
      tier: 'team',
      credentialType: 'oauth',
      status: 'active',
      keyHint: 'ABCD',
      externalGatewaySubscriptionId: 'secret-external-id',
      ...fields
    })
  }

  const list = (params = {}) =>
    service.listTeamDeployments(db, { actor: ADMIN, ...params })

  describe('listTeamDeployments', () => {
    test('lists one row per team in the environment, by team name, with models, status, credential and last change', async () => {
      const beta = await team('Beta Team')
      const alpha = await team('Alpha Team')

      await deployment(beta, DEV, [entry()])
      await deployment(alpha, DEV, [
        entry({ modelSlug: 'dep-claude' }),
        entry({
          status: 'deploying',
          statusTimes: { requested: '2026-11-01T09:00:00.000Z' }
        })
      ])
      await deployment(alpha, TEST, [entry()])
      await credentialOf(alpha, DEV)

      const result = await list({ environment: DEV })

      expect(result).toMatchObject({
        page: 1,
        pageSize: 25,
        total: 2,
        environment: DEV
      })
      expect(result.deployments).toEqual([
        {
          teamId: alpha,
          teamName: 'Alpha Team',
          environment: DEV,
          models: [
            { slug: 'dep-claude', name: 'Dep Claude' },
            { slug: 'dep-gpt', name: 'Dep GPT' }
          ],
          status: 'setting-up',
          credential: 'active',
          lastChangedAt: '2026-11-01T09:00:00.000Z'
        },
        {
          teamId: beta,
          teamName: 'Beta Team',
          environment: DEV,
          models: [{ slug: 'dep-gpt', name: 'Dep GPT' }],
          status: 'ready',
          credential: 'none',
          lastChangedAt: '2026-10-30T11:00:00.000Z'
        }
      ])
    })

    test('defaults to the first configured environment and offers every one, and the models in this one', async () => {
      const first = await team('First Team')
      const second = await team('Second Team')

      await deployment(first, DEV, [entry({ modelSlug: 'dep-claude' })])
      await deployment(second, TEST, [entry({ modelSlug: 'dep-gpt' })])

      const result = await list()

      expect(result.environment).toBe(DEV)
      expect(result.deployments.map(({ teamId }) => teamId)).toEqual([first])
      expect(result.options).toEqual({
        environments: ENVIRONMENTS,
        models: [{ slug: 'dep-claude', name: 'Dep Claude' }]
      })
    })

    test('leaves out a team whose models are all removed, and a removed model from a row', async () => {
      const gone = await team('Gone Team')
      const mixed = await team('Mixed Team')

      await deployment(gone, DEV, [entry({ status: 'removed' })])
      await deployment(mixed, DEV, [
        entry({ status: 'removed', modelSlug: 'dep-claude' }),
        entry()
      ])

      const result = await list({ environment: DEV })

      expect(result.deployments).toHaveLength(1)
      expect(result.deployments[0].models).toEqual([
        { slug: 'dep-gpt', name: 'Dep GPT' }
      ])
    })

    test('names a model by its slug when the catalogue no longer holds it', async () => {
      const id = await team('Orphan Model Team')

      await deployment(id, DEV, [entry({ modelSlug: 'dep-retired' })])

      const result = await list({ environment: DEV })

      expect(result.deployments[0].models).toEqual([
        { slug: 'dep-retired', name: 'dep-retired' }
      ])
    })

    test('a model that records no times is dated by its activation, else its request, else not at all', async () => {
      const dated = await team('Dated Team')
      const requested = await team('Requested Team')
      const undated = await team('Undated Team')

      await deployment(dated, DEV, [
        entry({
          statusTimes: undefined,
          activatedAt: '2026-09-01T00:00:00.000Z'
        })
      ])
      await deployment(requested, DEV, [
        entry({ statusTimes: undefined, createdAt: '2026-08-01T00:00:00.000Z' })
      ])
      await deployment(undated, DEV, [
        entry({ statusTimes: undefined, createdAt: undefined })
      ])

      const rows = Object.fromEntries(
        (await list({ environment: DEV })).deployments.map((row) => [
          row.teamName,
          row.lastChangedAt
        ])
      )

      expect(rows).toEqual({
        'Dated Team': '2026-09-01T00:00:00.000Z',
        'Requested Team': '2026-08-01T00:00:00.000Z',
        'Undated Team': null
      })
    })

    test('reads a status it does not know as a model still being set up, and a document with no deployments as no row', async () => {
      const odd = await team('Odd Status Team')
      const empty = await team('Empty Team')

      await deployment(odd, DEV, [entry({ status: 'something-new' })])
      await db
        .collection('teamDeployments')
        .insertOne({ teamId: empty, environment: DEV })

      const { deployments } = await list({ environment: DEV })

      expect(deployments).toHaveLength(1)
      expect(deployments[0].status).toBe('setting-up')
    })

    test('puts models with the same name in slug order', async () => {
      const first = await team('Twin Team')

      await db.collection('models').insertMany([
        { slug: 'dep-twin-b', displayName: 'Dep Twin' },
        { slug: 'dep-twin-a', displayName: 'Dep Twin' }
      ])
      await deployment(first, DEV, [
        entry({ modelSlug: 'dep-twin-b' }),
        entry({ modelSlug: 'dep-twin-a' })
      ])

      const { deployments } = await list({ environment: DEV })

      expect(deployments[0].models.map((m) => m.slug)).toEqual([
        'dep-twin-a',
        'dep-twin-b'
      ])
    })

    test('names a deployment by its team id when the team record is gone', async () => {
      const missing = new ObjectId().toString()

      await deployment(missing, DEV, [entry()])

      const result = await list({ environment: DEV })

      expect(result.deployments[0].teamName).toBe(missing)
    })

    test.each([
      [0, 1, 0],
      [25, 1, 25],
      [26, 1, 25],
      [26, 2, 1]
    ])('with %i teams, page %i holds %i rows', async (count, page, onPage) => {
      for (let index = 0; index < count; index += 1) {
        const id = await team(`Paged Team ${String(index).padStart(3, '0')}`)

        await deployment(id, DEV, [entry()])
      }

      const result = await list({ environment: DEV, page })

      expect(result).toMatchObject({ total: count, page, pageSize: 25 })
      expect(result.deployments).toHaveLength(onPage)
    })

    test('pages in team name order, and a page past the end is empty', async () => {
      for (const name of ['Zulu', 'Alpha', 'Mike']) {
        await deployment(await team(`${name} Page Team`), DEV, [entry()])
      }

      const { deployments } = await list({ environment: DEV })
      const past = await list({ environment: DEV, page: 2 })

      expect(deployments.map(({ teamName }) => teamName)).toEqual([
        'Alpha Page Team',
        'Mike Page Team',
        'Zulu Page Team'
      ])
      expect(past.deployments).toEqual([])
      expect(past.total).toBe(3)
    })

    describe('filters', () => {
      let flood
      let farm
      let river

      beforeEach(async () => {
        flood = await team('Flood Risk Team')
        farm = await team('Farm Payments')
        river = await team('River Levels')

        await deployment(flood, DEV, [entry({ modelSlug: 'dep-claude' })])
        await deployment(farm, DEV, [
          entry(),
          entry({ status: 'deploy-failed', modelSlug: 'dep-claude' })
        ])
        await deployment(river, DEV, [entry({ status: 'queued' })])
        await credentialOf(flood, DEV, { status: 'revoked' })
        await credentialOf(farm, DEV)
        await db
          .collection('teamDeployments')
          .updateOne(
            { teamId: river, environment: DEV },
            { $set: { adminBlocked: true, adminBlockedAt: 'x' } }
          )
      })

      const teamIds = (result) =>
        result.deployments.map(({ teamId }) => teamId).sort()

      test('by team name, any case, as part of the name', async () => {
        expect(
          teamIds(await list({ environment: DEV, search: 'RISK' }))
        ).toEqual([flood])
        expect(
          teamIds(await list({ environment: DEV, search: 'flood r' }))
        ).toEqual([flood])
      })

      test('by team name literally: a pattern matches nothing and nothing is a pattern', async () => {
        for (const search of [
          '.*',
          'fl.od',
          '^Flood',
          'Flood|Farm',
          '[a-z]+'
        ]) {
          expect(
            (await list({ environment: DEV, search })).deployments
          ).toEqual([])
        }
      })

      test('by model', async () => {
        expect(
          teamIds(await list({ environment: DEV, model: 'dep-claude' }))
        ).toEqual([flood, farm].sort())
        expect(
          teamIds(await list({ environment: DEV, model: 'dep-gpt' }))
        ).toEqual([farm, river].sort())
      })

      test.each([
        ['ready', ['flood']],
        ['needs-attention', ['farm']],
        ['waiting', ['river']],
        ['setting-up', []],
        ['removing', []]
      ])('by status %s', async (status, names) => {
        const ids = { flood, farm, river }

        expect(teamIds(await list({ environment: DEV, status }))).toEqual(
          names.map((name) => ids[name]).sort()
        )
      })

      test.each([
        ['active', ['farm']],
        ['revoked', ['flood']],
        ['disabled', ['river']],
        ['none', []]
      ])('by credential %s', async (credential, names) => {
        const ids = { flood, farm, river }

        expect(teamIds(await list({ environment: DEV, credential }))).toEqual(
          names.map((name) => ids[name]).sort()
        )
      })

      test('combined, every filter must hold', async () => {
        expect(
          teamIds(
            await list({
              environment: DEV,
              search: 'farm',
              model: 'dep-claude',
              status: 'needs-attention',
              credential: 'active'
            })
          )
        ).toEqual([farm])
        expect(
          await list({
            environment: DEV,
            search: 'farm',
            credential: 'revoked'
          })
        ).toMatchObject({ deployments: [], total: 0 })
      })

      test('and the total is of the filtered rows', async () => {
        expect(
          (await list({ environment: DEV, model: 'dep-claude' })).total
        ).toBe(2)
      })
    })

    describe('status is the worst state of the models', () => {
      test.each([
        [['active'], 'ready'],
        [['active', 'requested'], 'setting-up'],
        [['committed'], 'setting-up'],
        [['deploying'], 'setting-up'],
        [['deployed'], 'setting-up'],
        [['verified'], 'setting-up'],
        [['active', 'queued'], 'waiting'],
        [['removing'], 'removing'],
        [['active', 'removing'], 'removing'],
        [['requested', 'removing'], 'setting-up'],
        [['active', 'checks-failed'], 'needs-attention'],
        [['deploy-failed', 'queued'], 'needs-attention'],
        [['timed-out', 'deploying'], 'needs-attention']
      ])('%j reads %s', async (statuses, expected) => {
        const id = await team(`Worst ${statuses.join('-')}`)

        await deployment(
          id,
          DEV,
          statuses.map((status) =>
            entry({
              status,
              statusTimes: { [status]: '2026-10-30T11:00:00.000Z' }
            })
          )
        )

        expect((await list({ environment: DEV })).deployments[0].status).toBe(
          expected
        )
      })
    })

    describe('credential column', () => {
      test.each([
        ['an active record', [{ status: 'active' }], false, 'active'],
        ['only revoked records', [{ status: 'revoked' }], false, 'revoked'],
        ['no record', [], false, 'none'],
        ['a failed attempt only', [{ status: 'failed' }], false, 'none'],
        [
          'a block over an active record',
          [{ status: 'active' }],
          true,
          'disabled'
        ],
        ['a block over none', [], true, 'disabled']
      ])('reads %s', async (_name, records, blocked, expected) => {
        const id = await team('Credential Column')

        await deployment(
          id,
          DEV,
          [entry()],
          blocked ? { adminBlocked: true } : {}
        )

        for (const record of records) {
          await credentialOf(id, DEV, record)
        }

        expect(
          (await list({ environment: DEV })).deployments[0].credential
        ).toBe(expected)
      })

      test('ignores another environment’s credential, a research key and another team’s credential', async () => {
        const id = await team('Credential Scope')
        const other = await team('Credential Other')

        await deployment(id, DEV, [entry()])
        await credentialOf(id, TEST)
        await credentialOf(id, DEV, { tier: 'research' })
        await credentialOf(other, DEV)

        expect(
          (await list({ environment: DEV, search: 'Credential Scope' }))
            .deployments[0].credential
        ).toBe('none')
      })
    })

    test('never carries a secret, key hint or external ID', async () => {
      const id = await team('No Secrets Team')

      await deployment(id, DEV, [entry()])
      await credentialOf(id, DEV)

      const text = JSON.stringify(await list({ environment: DEV }))

      expect(text).not.toContain('ABCD')
      expect(text).not.toContain('secret-external-id')
    })

    describe('is refused', () => {
      test('for a person who is not a Platform Admin: 403 platform-admin-required, audited, nothing read', async () => {
        await expect(
          service.listTeamDeployments(db, { actor: TEAM_ADMIN })
        ).rejects.toMatchObject({
          output: { statusCode: 403 },
          data: { code: 'platform-admin-required' }
        })

        expect(
          await db
            .collection('auditEvents')
            .countDocuments({ action: 'access.denied' })
        ).toBe(1)
      })

      test.each([
        [{ environment: 'not-configured' }],
        [{ environment: 'sandbox' }]
      ])(
        'for an environment the instance does not list (%j)',
        async (params) => {
          await expect(list(params)).rejects.toMatchObject({
            output: { statusCode: 400 },
            data: { code: 'invalid-query' }
          })
        }
      )

      test.each([
        [{ status: 'broken' }],
        [{ credential: 'broken' }],
        [{ page: 0 }],
        [{ page: 1.5 }]
      ])('for a value that is not valid (%j)', async (params) => {
        await expect(list(params)).rejects.toMatchObject({
          data: { code: 'invalid-query' }
        })
      })
    })

    test('a read writes no audit event', async () => {
      const id = await team('Read Only Team')

      await deployment(id, DEV, [entry()])
      await list({ environment: DEV, search: 'read' })

      expect(await db.collection('auditEvents').countDocuments()).toBe(0)
    })

    test('reads a page of 200 teams in under a second, with and without filters', async () => {
      const teamDocs = []
      const deploymentDocs = []

      for (let index = 0; index < 200; index += 1) {
        const _id = new ObjectId()
        const name = `Bulk Team ${String(index).padStart(3, '0')}`

        teamDocs.push({
          _id,
          name,
          normalisedName: name.toLowerCase().replaceAll(' ', '-'),
          slug: name.toLowerCase().replaceAll(' ', '-')
        })
        deploymentDocs.push({
          teamId: _id.toString(),
          environment: DEV,
          deployments: [entry(), entry({ modelSlug: 'dep-claude' })]
        })
      }

      await db.collection('teams').insertMany(teamDocs)
      await db.collection('teamDeployments').insertMany(deploymentDocs)

      for (const params of [
        {},
        { search: 'bulk team 19' },
        { model: 'dep-claude', status: 'ready', credential: 'none', page: 8 }
      ]) {
        const started = performance.now()
        const result = await list({ environment: DEV, ...params })

        expect(result.deployments.length).toBeGreaterThan(0)
        expect(performance.now() - started).toBeLessThan(1000)
      }
    })

    describe('reads through the indexes', () => {
      test('one environment’s deployment documents by the environment index', async () => {
        const plan = await service
          .deploymentDocumentsCursor(db, DEV)
          .explain('queryPlanner')

        expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(
          'environment_1_teamId_1'
        )
      })

      test('a page of teams’ credentials by the team, environment and tier index', async () => {
        const plan = await service
          .teamCredentialsCursor(db, { teamIds: ['a', 'b'], environment: DEV })
          .explain('queryPlanner')

        expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(
          'teamId_1_environment_1_tier_1'
        )
      })
    })
  })

  describe('getTeamDeployment', () => {
    const detail = (params) =>
      service.getTeamDeployment(db, { actor: ADMIN, ...params })

    async function seedDetail() {
      const id = await team('Detail Team', { status: 'disabled' })

      await db.collection('teamMembers').insertMany([
        { teamId: id, userId: 'm1', role: 'admin', status: 'active' },
        { teamId: id, userId: 'm2', role: 'user', status: 'active' },
        { teamId: id, userId: 'm3', role: 'user', status: 'removed' }
      ])

      return id
    }

    test('returns the team, the environment, the worst status, the credential, each model and the team’s environments', async () => {
      const id = await seedDetail()
      const good = entry({ id: 'op-1' })
      const failed = entry({
        id: 'op-2',
        modelSlug: 'dep-claude',
        status: 'deploy-failed',
        failureReason: 'The deployment failed',
        statusTimes: {
          deploying: '2026-11-01T08:00:00.000Z',
          'deploy-failed': '2026-11-01T09:00:00.000Z'
        }
      })

      await deployment(id, DEV, [good, failed])
      await deployment(id, TEST, [entry()], {
        adminBlocked: true,
        adminBlockedAt: '2026-11-02T10:00:00.000Z'
      })
      await credentialOf(id, DEV)

      expect(await detail({ teamId: id, environment: DEV })).toEqual({
        team: {
          id,
          name: 'Detail Team',
          status: 'disabled',
          memberCount: 2
        },
        environment: DEV,
        status: 'needs-attention',
        credential: { status: 'active' },
        deployments: [
          {
            id: 'op-1',
            modelSlug: 'dep-gpt',
            modelName: 'Dep GPT',
            status: 'active',
            detail: null,
            updatedAt: '2026-10-30T11:00:00.000Z',
            retryable: false
          },
          {
            id: 'op-2',
            modelSlug: 'dep-claude',
            modelName: 'Dep Claude',
            status: 'deploy-failed',
            detail: 'The deployment failed',
            updatedAt: '2026-11-01T09:00:00.000Z',
            retryable: false
          }
        ],
        environments: [
          { environment: DEV, credential: { status: 'active' } },
          {
            environment: TEST,
            credential: {
              status: 'disabled',
              blockedAt: '2026-11-02T10:00:00.000Z',
              held: 'none'
            }
          }
        ]
      })
    })

    test('a team with no status reads as active, and a removed model is not listed', async () => {
      const id = await team('Plain Team')

      await deployment(id, DEV, [entry(), entry({ status: 'removed' })])

      const result = await detail({ teamId: id, environment: DEV })

      expect(result.team).toMatchObject({ status: 'active', memberCount: 0 })
      expect(result.deployments).toHaveLength(1)
    })

    test('a team with no models left reads ready with no rows, and an environment the instance no longer lists comes after the listed ones', async () => {
      const id = await team('Environments Team')

      await db.collection('teamDeployments').insertMany([
        { teamId: id, environment: DEV },
        { teamId: id, environment: 'zeta-env', deployments: [] },
        { teamId: id, environment: 'alpha-env', deployments: [] }
      ])

      const result = await detail({ teamId: id, environment: DEV })

      expect(result).toMatchObject({ status: 'ready', deployments: [] })
      expect(result.environments.map((e) => e.environment)).toEqual([
        DEV,
        'alpha-env',
        'zeta-env'
      ])
    })

    test('a disabled environment shows disabled, and a revoked one that is enabled again shows revoked', async () => {
      const id = await team('Block Team')

      await deployment(id, DEV, [entry()])
      await credentialOf(id, DEV, { status: 'revoked' })

      expect(
        (await detail({ teamId: id, environment: DEV })).credential
      ).toEqual({ status: 'revoked' })

      await block.blockCredentials(db, {
        teamId: id,
        environment: DEV,
        actor: ADMIN
      })

      expect(
        (await detail({ teamId: id, environment: DEV })).credential
      ).toMatchObject({
        status: 'disabled',
        blockedAt: expect.any(String),
        held: 'revoked'
      })
    })

    describe('retryable comes from the model’s operation', () => {
      async function withOperation(entryFields, operation) {
        const id = await team(`Retry ${randomUUID().slice(0, 6)}`)
        const operationId = randomUUID()

        await db
          .collection('operations')
          .insertOne({ _id: operationId, teamId: id, ...operation })
        await deployment(id, DEV, [
          entry({ operationId, operation: { id: operationId }, ...entryFields })
        ])

        return (await detail({ teamId: id, environment: DEV })).deployments[0]
          .retryable
      }

      test.each([
        [
          'a failed apply',
          { status: 'deploy-failed' },
          { state: 'deploy-failed' },
          true
        ],
        [
          'a timed-out operation',
          { status: 'timed-out' },
          { state: 'timed-out' },
          true
        ],
        [
          'a held write',
          { status: 'queued' },
          { state: 'queued', held: { since: 'x' } },
          true
        ],
        [
          'a failed check',
          { status: 'checks-failed' },
          { state: 'checks-failed' },
          false
        ],
        [
          'a write waiting for the file',
          { status: 'queued' },
          { state: 'queued' },
          false
        ],
        ['an active model', { status: 'active' }, { state: 'active' }, false]
      ])('%s', async (_name, entryFields, operation, expected) => {
        expect(await withOperation(entryFields, operation)).toBe(expected)
      })

      test('is false for a failed model whose operation is gone', async () => {
        const id = await team('Lost Operation')

        await deployment(id, DEV, [
          entry({ status: 'deploy-failed', operationId: randomUUID() })
        ])

        expect(
          (await detail({ teamId: id, environment: DEV })).deployments[0]
            .retryable
        ).toBe(false)
      })
    })

    test.each([
      [
        'an unknown team',
        () => ({ teamId: new ObjectId().toString(), environment: DEV })
      ],
      [
        'a team that is not an ID',
        () => ({ teamId: 'no-such-team', environment: DEV })
      ],
      [
        'an environment the team has no document in',
        async () => {
          const id = await team('Only Dev')

          await deployment(id, DEV, [entry()])

          return { teamId: id, environment: TEST }
        }
      ],
      [
        'an environment the instance does not list',
        async () => {
          const id = await team('Unlisted')

          await deployment(id, 'sandbox', [entry()])

          return { teamId: id, environment: 'sandbox' }
        }
      ]
    ])('is 404 deployment-not-found for %s', async (_name, target) => {
      await expect(detail(await target())).rejects.toMatchObject({
        output: { statusCode: 404 },
        data: { code: 'deployment-not-found' }
      })
    })

    test('is 404 when the team record is gone though its document is not', async () => {
      const missing = new ObjectId().toString()

      await deployment(missing, DEV, [entry()])

      await expect(
        detail({ teamId: missing, environment: DEV })
      ).rejects.toMatchObject({ data: { code: 'deployment-not-found' } })
    })

    test('is refused for a person who is not a Platform Admin, before anything is read, audited', async () => {
      const id = await seedDetail()

      await deployment(id, DEV, [entry()])

      await expect(
        service.getTeamDeployment(db, {
          actor: TEAM_ADMIN,
          teamId: id,
          environment: DEV
        })
      ).rejects.toMatchObject({
        output: { statusCode: 403 },
        data: { code: 'platform-admin-required' }
      })
      expect(
        await db.collection('auditEvents').findOne({ action: 'access.denied' })
      ).toMatchObject({ resource: 'teamDeployment', resourceId: id })
    })

    test('never carries a secret, key hint or external ID, and writes no event', async () => {
      const id = await seedDetail()

      await deployment(id, DEV, [entry()])
      await credentialOf(id, DEV)

      const text = JSON.stringify(
        await detail({ teamId: id, environment: DEV })
      )

      expect(text).not.toContain('ABCD')
      expect(text).not.toContain('secret-external-id')
      expect(await db.collection('auditEvents').countDocuments()).toBe(0)
    })
  })
})
