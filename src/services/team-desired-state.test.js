import { randomUUID } from 'node:crypto'

const TEAM_MODEL = {
  slug: 'gpt-5-nano-desired',
  tiers: ['research', 'team'],
  environments: ['sandbox', 'infradev'],
  eligible: true,
  skus: [
    { name: 'GlobalStandard', capacity: 250, tiers: ['research'] },
    { name: 'DataZoneStandard', tiers: ['team'], regions: ['swedencentral'] }
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
      output: { statusCode: 403 },
      data: { code: 'model-not-eligible' }
    })
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
