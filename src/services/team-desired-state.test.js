import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

// The team file schema as ai-platform-infra publishes it, copied under
// fixtures: a document the builder produces must validate against it, with
// only `updatedBy` added by the caller.
const TEAM_SCHEMA = JSON.parse(
  readFileSync(
    new URL(
      '../common/fixtures/gitops/ai-platform-infra/schemas/team.schema.json',
      import.meta.url
    ),
    'utf8'
  )
)
const validateTeamFile = addFormats(new Ajv2020({ allErrors: true })).compile(
  TEAM_SCHEMA
)
const PRINCIPAL = 'entra:00000000-0000-0000-0000-000000000001'

function schemaProblems(document) {
  validateTeamFile({ ...document, updatedBy: PRINCIPAL })

  return (validateTeamFile.errors ?? []).map(
    (error) => `${error.instancePath} ${error.message}`
  )
}

const TEAM_MODEL = {
  slug: 'gpt-5-nano-desired',
  tiers: ['research', 'team'],
  environments: ['sandbox', 'infradev', 'qa', 'preprod'],
  eligible: true,
  skus: [
    { name: 'GlobalStandard', capacity: 250, tiers: ['research'] },
    { name: 'DataZoneStandard', tiers: ['team'], regions: ['uksouth'] }
  ],
  capacityPolicy: {
    min: 1,
    max: 50,
    default: 5,
    environments: { infradev: { min: 1, max: 5, default: 2, quota: 10 } }
  },
  limitsDefault: { requestsPerMinute: 90, tokensPerDay: 100000 }
}

describe('#createTeamDesiredStateBuilder', () => {
  let server
  let db
  let createTeamDesiredStateBuilder
  let invalidateModelsCache

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
    ;({ createTeamDesiredStateBuilder } =
      await import('#/services/team-desired-state.js'))
    ;({ invalidateModelsCache } = await import('#/services/models-service.js'))

    await db.collection('models').insertOne({ ...TEAM_MODEL })
    invalidateModelsCache()
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  function orchestrator(document = null) {
    return {
      getCurrentDocument: vi.fn(async () => ({ document }))
    }
  }

  function build(current) {
    const registry = { orchestrator: orchestrator(current) }
    const builder = createTeamDesiredStateBuilder({ registry })

    return { builder, registry }
  }

  async function team(fields = {}) {
    const { insertedId } = await db.collection('teams').insertOne({
      name: 'Desired State Team',
      normalisedName: `desired-state-${randomUUID()}`,
      slug: `desired-${randomUUID().slice(0, 8)}`,
      serviceCode: 'ABC',
      createdBy: 'user-1',
      createdAt: new Date().toISOString(),
      ...fields
    })
    const stored = await db.collection('teams').findOne({ _id: insertedId })

    return { teamId: insertedId.toString(), slug: stored.slug }
  }

  async function buildFor(current, { teamFields, params } = {}) {
    const { teamId, slug } = await team(teamFields)
    const { builder, registry } = build(current)
    const result = await builder(db, {
      teamId,
      environment: 'infradev',
      modelSlug: TEAM_MODEL.slug,
      operationId: '651f2c0f5c1b4a0012ab34cd',
      requestedBy: 'user-1',
      ...params
    })

    return { result, slug, registry }
  }

  test('builds revision 1 for a team with no file on main', async () => {
    const { result, slug, registry } = await buildFor(null)

    expect(registry.orchestrator.getCurrentDocument).toHaveBeenCalledWith({
      path: `environments/infradev/${slug}.json`
    })
    expect(result.expectedRevision).toBe(0)
    expect(result.document).toEqual({
      schemaVersion: 1,
      revision: 1,
      environment: 'infradev',
      status: 'active',
      team: { slug, serviceCode: 'ABC' },
      deployments: [
        {
          slug: TEAM_MODEL.slug,
          sku: 'DataZoneStandard',
          capacity: 2,
          status: 'active'
        }
      ],
      gateway: {
        credentialType: 'oauth',
        allowedDeployments: [TEAM_MODEL.slug],
        limits: { tokensPerMinute: 1000, requestsPerMinute: 90 }
      },
      oauth: { federations: [], externalClients: [], secretsAllowed: true },
      operationId: '651f2c0f5c1b4a0012ab34cd',
      updatedAt: expect.any(String)
    })
  })

  test('leaves updatedBy to the caller, which sets the requester principal', async () => {
    const { result } = await buildFor(null)

    expect(result.document).not.toHaveProperty('updatedBy')
  })

  test('builds a document the infra team schema accepts, with updatedBy added', async () => {
    const { result } = await buildFor(null)

    expect(schemaProblems(result.document)).toEqual([])
    expect(schemaProblems({ ...result.document, status: 'gone' })).not.toEqual(
      []
    )
  })

  test('adds the model to the file on main, keeping its federations and agreed limits', async () => {
    const current = {
      $schema: '../../../../schemas/team.schema.json',
      schemaVersion: 1,
      revision: 4,
      environment: 'infradev',
      status: 'active',
      team: { slug: 'ignored', serviceCode: 'ZZZ' },
      deployments: [
        {
          slug: 'gpt-4-1-nano',
          sku: 'DataZoneStandard',
          capacity: 1,
          status: 'active'
        }
      ],
      gateway: {
        credentialType: 'oauth',
        allowedDeployments: ['gpt-4-1-nano'],
        limits: { tokensPerMinute: 25000, requestsPerMinute: 120 }
      },
      oauth: {
        federations: [{ name: 'beta-api', host: 'cdp', service: 'beta-api' }],
        externalClients: [],
        secretsAllowed: false
      },
      operationId: 'earlier-operation-id',
      updatedBy: 'entra:00000000-0000-0000-0000-000000000001',
      updatedAt: '2026-10-13T00:00:00.000Z'
    }

    const { result, slug } = await buildFor(current)

    expect(result.expectedRevision).toBe(4)
    expect(result.document.revision).toBe(5)
    expect(result.document.$schema).toBe(current.$schema)
    expect(result.document.team).toEqual({ slug, serviceCode: 'ABC' })
    expect(result.document.deployments).toEqual([
      current.deployments[0],
      {
        slug: TEAM_MODEL.slug,
        sku: 'DataZoneStandard',
        capacity: 2,
        status: 'active'
      }
    ])
    expect(result.document.gateway.allowedDeployments).toEqual([
      'gpt-4-1-nano',
      TEAM_MODEL.slug
    ])
    expect(result.document.gateway.limits).toEqual(current.gateway.limits)
    expect(result.document.oauth).toEqual(current.oauth)
  })

  test('does not repeat a model the team already holds', async () => {
    const { teamId, slug } = await team()
    const { builder } = build({
      schemaVersion: 1,
      revision: 2,
      environment: 'infradev',
      status: 'active',
      team: { slug, serviceCode: 'ABC' },
      deployments: [
        {
          slug: TEAM_MODEL.slug,
          sku: 'DataZoneStandard',
          capacity: 9,
          status: 'active'
        }
      ],
      gateway: {
        credentialType: 'oauth',
        allowedDeployments: [TEAM_MODEL.slug],
        limits: { tokensPerMinute: 1000, requestsPerMinute: 60 }
      },
      oauth: { federations: [], externalClients: [], secretsAllowed: true }
    })

    const { document } = await builder(db, {
      teamId,
      environment: 'infradev',
      modelSlug: TEAM_MODEL.slug,
      operationId: '651f2c0f5c1b4a0012ab34ce',
      requestedBy: 'user-1'
    })

    expect(document.deployments).toEqual([
      {
        slug: TEAM_MODEL.slug,
        sku: 'DataZoneStandard',
        capacity: 9,
        status: 'active'
      }
    ])
    expect(document.gateway.allowedDeployments).toEqual([TEAM_MODEL.slug])
  })

  test('falls back to the catalogue default capacity outside a named environment', async () => {
    const { result } = await buildFor(null, {
      params: { environment: 'sandbox' }
    })

    expect(result.document.deployments[0].capacity).toBe(5)
  })

  describe('limits in a new environment', () => {
    let config
    let configuredEnvironments

    beforeAll(async () => {
      ;({ config } = await import('#/config.js'))
      configuredEnvironments = config.get('teamDeployment.environments')
    })

    beforeEach(() => {
      config.set('teamDeployment.environments', ['infradev', 'qa', 'preprod'])
    })

    afterEach(() => {
      config.set('teamDeployment.environments', configuredEnvironments)
    })

    function fileWithLimits(limits) {
      return {
        schemaVersion: 1,
        revision: 3,
        gateway: { credentialType: 'oauth', allowedDeployments: [], limits }
      }
    }

    // The files `main` holds for a team, by environment.
    async function buildIn(environment, filesByEnvironment) {
      const { teamId, slug } = await team()
      const getCurrentDocument = vi.fn(async ({ path }) => {
        const [, env] = path.match(/^environments\/([^/]+)\//)

        return { document: filesByEnvironment[env] ?? null }
      })
      const builder = createTeamDesiredStateBuilder({
        registry: { orchestrator: { getCurrentDocument } }
      })
      const { document } = await builder(db, {
        teamId,
        environment,
        modelSlug: TEAM_MODEL.slug,
        operationId: '651f2c0f5c1b4a0012ab34cf'
      })

      return { document, slug, getCurrentDocument }
    }

    test("copies the limits of the team's first environment", async () => {
      const { document, slug, getCurrentDocument } = await buildIn('qa', {
        infradev: fileWithLimits({
          requestsPerMinute: 77,
          tokensPerMinute: 4000
        })
      })

      expect(document.revision).toBe(1)
      expect(document.gateway.limits).toEqual({
        requestsPerMinute: 77,
        tokensPerMinute: 4000
      })
      expect(getCurrentDocument).toHaveBeenCalledWith({
        path: `environments/infradev/${slug}.json`
      })
    })

    test('takes the first environment in order that has a file, not the one being set up', async () => {
      const { document } = await buildIn('infradev', {
        preprod: fileWithLimits({
          requestsPerMinute: 11,
          tokensPerMinute: 2200
        }),
        qa: fileWithLimits({ requestsPerMinute: 33, tokensPerMinute: 3300 })
      })

      expect(document.gateway.limits).toEqual({
        requestsPerMinute: 33,
        tokensPerMinute: 3300
      })
    })

    test('keeps its own limits in an environment that already has a file', async () => {
      const { document } = await buildIn('qa', {
        infradev: fileWithLimits({
          requestsPerMinute: 77,
          tokensPerMinute: 4000
        }),
        qa: fileWithLimits({ requestsPerMinute: 5, tokensPerMinute: 500 })
      })

      expect(document.revision).toBe(4)
      expect(document.gateway.limits).toEqual({
        requestsPerMinute: 5,
        tokensPerMinute: 500
      })
    })

    test('starts from the defaults when the team has no file anywhere else', async () => {
      const { document, getCurrentDocument } = await buildIn('qa', {})

      expect(document.gateway.limits).toEqual({
        requestsPerMinute: 90,
        tokensPerMinute: 1000
      })
      expect(getCurrentDocument).toHaveBeenCalledTimes(3)
    })

    test('skips another environment whose file states no limits', async () => {
      const { document } = await buildIn('preprod', {
        infradev: { schemaVersion: 1, revision: 1, gateway: {} },
        qa: fileWithLimits({ requestsPerMinute: 33, tokensPerMinute: 3300 })
      })

      expect(document.gateway.limits).toEqual({
        requestsPerMinute: 33,
        tokensPerMinute: 3300
      })
    })
  })

  describe('a removal', () => {
    const current = {
      schemaVersion: 1,
      revision: 6,
      environment: 'infradev',
      status: 'active',
      team: { slug: 'ignored', serviceCode: 'ZZZ' },
      deployments: [
        {
          slug: 'gpt-4-1-nano',
          sku: 'DataZoneStandard',
          capacity: 1,
          status: 'active'
        },
        {
          slug: TEAM_MODEL.slug,
          sku: 'DataZoneStandard',
          capacity: 2,
          status: 'active'
        }
      ],
      gateway: {
        credentialType: 'oauth',
        allowedDeployments: ['gpt-4-1-nano', TEAM_MODEL.slug],
        limits: { tokensPerMinute: 25000, requestsPerMinute: 120 }
      },
      oauth: {
        federations: [{ name: 'beta-api', host: 'cdp', service: 'beta-api' }],
        externalClients: [],
        secretsAllowed: false
      },
      operationId: 'earlier-operation-id',
      updatedBy: PRINCIPAL,
      updatedAt: '2026-10-13T00:00:00.000Z'
    }

    test('writes the file without the model and its grant, keeping everything else', async () => {
      const { result, slug } = await buildFor(current, {
        params: { change: 'remove' }
      })

      expect(result.expectedRevision).toBe(6)
      expect(result.document.revision).toBe(7)
      expect(result.document.team).toEqual({ slug, serviceCode: 'ABC' })
      expect(result.document.deployments).toEqual([current.deployments[0]])
      expect(result.document.gateway).toEqual({
        credentialType: 'oauth',
        allowedDeployments: ['gpt-4-1-nano'],
        limits: current.gateway.limits
      })
      expect(result.document.oauth).toEqual(current.oauth)
      expect(schemaProblems(result.document)).toEqual([])
    })

    test('removes the last model, leaving the team active with none', async () => {
      const { result } = await buildFor(
        {
          ...current,
          deployments: [current.deployments[1]],
          gateway: { ...current.gateway, allowedDeployments: [TEAM_MODEL.slug] }
        },
        { params: { change: 'remove' } }
      )

      expect(result.document.status).toBe('active')
      expect(result.document.deployments).toEqual([])
      expect(result.document.gateway.allowedDeployments).toEqual([])
      expect(schemaProblems(result.document)).toEqual([])
    })

    test('needs no eligible model, so a retired model can still be removed', async () => {
      const { result } = await buildFor(current, {
        params: { change: 'remove', modelSlug: 'gpt-4-1-nano' }
      })

      expect(result.document.deployments.map((d) => d.slug)).toEqual([
        TEAM_MODEL.slug
      ])
      expect(result.document.gateway.allowedDeployments).toEqual([
        TEAM_MODEL.slug
      ])
    })

    test('is the file unchanged, at the next revision, when the model is already absent', async () => {
      const { result } = await buildFor(current, {
        params: { change: 'remove', modelSlug: 'never-held' }
      })

      expect(result.document.revision).toBe(7)
      expect(result.document.deployments).toEqual(current.deployments)
      expect(result.document.gateway.allowedDeployments).toEqual(
        current.gateway.allowedDeployments
      )
    })
  })

  test('refuses a team whose service code is not three characters', async () => {
    await expect(
      buildFor(null, { teamFields: { serviceCode: 'ai-platform' } })
    ).rejects.toMatchObject({
      output: { statusCode: 409 },
      data: { code: 'service-code-required' }
    })
  })

  test('refuses a model with no team tier SKU', async () => {
    await db
      .collection('models')
      .insertOne({ slug: 'research-only-desired', tiers: ['research'] })
    invalidateModelsCache()

    await expect(
      buildFor(null, { params: { modelSlug: 'research-only-desired' } })
    ).rejects.toMatchObject({
      output: { statusCode: 400 },
      data: { code: 'model-not-eligible' }
    })
  })

  test('refuses a model whose only team SKU is outside the UK', async () => {
    await db.collection('models').insertOne({
      ...TEAM_MODEL,
      slug: 'sweden-only-desired',
      skus: [
        {
          name: 'DataZoneStandard',
          tiers: ['team'],
          regions: ['swedencentral']
        }
      ]
    })
    invalidateModelsCache()

    await expect(
      buildFor(null, { params: { modelSlug: 'sweden-only-desired' } })
    ).rejects.toMatchObject({
      output: { statusCode: 400 },
      data: { code: 'model-not-eligible' }
    })
  })

  test('refuses a model its catalogue does not list for the environment', async () => {
    await expect(
      buildFor(null, { params: { environment: 'prod' } })
    ).rejects.toMatchObject({
      output: { statusCode: 400 },
      data: { code: 'model-not-eligible' }
    })
  })

  test('takes the UK team SKU when the model also has one elsewhere', async () => {
    await db.collection('models').insertOne({
      ...TEAM_MODEL,
      slug: 'two-skus-desired',
      skus: [
        { name: 'GlobalStandard', tiers: ['team'], regions: ['swedencentral'] },
        { name: 'DataZoneStandard', tiers: ['team'], regions: ['uksouth'] }
      ]
    })
    invalidateModelsCache()

    const { result } = await buildFor(null, {
      params: { modelSlug: 'two-skus-desired' }
    })

    expect(result.document.deployments).toEqual([
      expect.objectContaining({
        slug: 'two-skus-desired',
        sku: 'DataZoneStandard'
      })
    ])
  })

  test('builds nothing for a team id that is not a team', async () => {
    const { builder } = build(null)

    const result = await builder(db, {
      teamId: 'not-an-object-id',
      environment: 'infradev',
      modelSlug: TEAM_MODEL.slug,
      operationId: '651f2c0f5c1b4a0012ab34cf',
      requestedBy: 'user-1'
    })

    expect(result).toBeNull()
  })
})
