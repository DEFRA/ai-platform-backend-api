import { backfillRegistry } from '#/common/backfills/registry.js'

describe('#backfillRegistry', () => {
  let server
  let db

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  function findBackfill(id) {
    return backfillRegistry.find((backfill) => backfill.id === id)
  }

  describe('2026-09-25-credentials-environment-default', () => {
    test('sets environment: null on a credential doc missing it', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'legacy-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'active'
      })

      const { modifiedCount } = await findBackfill(
        '2026-09-25-credentials-environment-default'
      ).run(db)

      expect(modifiedCount).toBeGreaterThanOrEqual(1)
      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated.environment).toBeNull()
    })

    test('leaves a credential doc with an existing environment untouched', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'team-user',
        tier: 'team',
        environment: 'sandbox',
        status: 'active'
      })

      await findBackfill('2026-09-25-credentials-environment-default').run(db)

      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated.environment).toBe('sandbox')
    })
  })

  describe('2026-10-01-credentials-issuer-key-default', () => {
    test('sets issuerKey: "mock" on a credential doc missing it', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'pre-registry-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'active'
      })

      const { modifiedCount } = await findBackfill(
        '2026-10-01-credentials-issuer-key-default'
      ).run(db)

      expect(modifiedCount).toBeGreaterThanOrEqual(1)
      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated.issuerKey).toBe('mock')
    })

    test('leaves a credential doc with an existing issuerKey untouched', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'azure-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'active',
        issuerKey: 'azure'
      })

      await findBackfill('2026-10-01-credentials-issuer-key-default').run(db)

      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated.issuerKey).toBe('azure')
    })
  })

  describe('2026-10-02-credentials-external-gateway-subscription-id', () => {
    test('copies apimSubscriptionId into externalGatewaySubscriptionId on a credential doc missing it', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'pre-rename-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'active',
        apimSubscriptionId: 'research-pre-rename-user-gpt-4o'
      })

      const { modifiedCount } = await findBackfill(
        '2026-10-02-credentials-external-gateway-subscription-id'
      ).run(db)

      expect(modifiedCount).toBeGreaterThanOrEqual(1)
      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated.externalGatewaySubscriptionId).toBe(
        'research-pre-rename-user-gpt-4o'
      )
      // The old field is kept, not unset, until the fallback reads are removed.
      expect(updated.apimSubscriptionId).toBe('research-pre-rename-user-gpt-4o')
    })

    test('leaves a credential doc that never had apimSubscriptionId (e.g. pending) without the new field', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'never-issued-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'pending'
      })

      await findBackfill(
        '2026-10-02-credentials-external-gateway-subscription-id'
      ).run(db)

      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated.externalGatewaySubscriptionId).toBeUndefined()
    })

    test('leaves a credential doc with an existing externalGatewaySubscriptionId untouched', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'already-migrated-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'active',
        apimSubscriptionId: 'old-value',
        externalGatewaySubscriptionId: 'already-set'
      })

      await findBackfill(
        '2026-10-02-credentials-external-gateway-subscription-id'
      ).run(db)

      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated.externalGatewaySubscriptionId).toBe('already-set')
    })
  })

  describe('2026-10-07-credentials-provider-cloud-adapter', () => {
    test('snapshots provider/offering/cloud/adapter from the credential model', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'pre-cloud-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'active'
      })

      await findBackfill('2026-10-07-credentials-provider-cloud-adapter').run(
        db
      )

      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated).toMatchObject({
        provider: 'openai',
        offering: 'azure-openai',
        cloud: 'azure',
        adapter: 'azure-apim'
      })
    })

    test('records only cloud/adapter on a team credential and defaults them for an unknown model', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'pre-cloud-team-user',
        modelSlug: null,
        allowedDeployments: ['no-longer-in-catalogue'],
        tier: 'team',
        status: 'active'
      })

      await findBackfill('2026-10-07-credentials-provider-cloud-adapter').run(
        db
      )

      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated).toMatchObject({
        provider: null,
        offering: null,
        cloud: 'azure',
        adapter: 'azure-apim'
      })
    })

    test('leaves a credential that already has an adapter untouched', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'bedrock-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'active',
        provider: 'anthropic',
        cloud: 'aws',
        adapter: 'aws-bedrock'
      })

      await findBackfill('2026-10-07-credentials-provider-cloud-adapter').run(
        db
      )

      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated).toMatchObject({
        provider: 'anthropic',
        cloud: 'aws',
        adapter: 'aws-bedrock'
      })
    })
  })

  describe('2026-10-07-models-cloud-adapter-default', () => {
    test('sets cloud/adapter on a model doc missing them and leaves others alone', async () => {
      const legacy = await db
        .collection('models')
        .insertOne({ slug: 'backfill-legacy-model' })
      const bedrock = await db.collection('models').insertOne({
        slug: 'backfill-bedrock-model',
        cloud: 'aws',
        adapter: 'aws-bedrock'
      })

      await findBackfill('2026-10-07-models-cloud-adapter-default').run(db)

      expect(
        await db.collection('models').findOne({ _id: legacy.insertedId })
      ).toMatchObject({ cloud: 'azure', adapter: 'azure-apim' })
      expect(
        await db.collection('models').findOne({ _id: bedrock.insertedId })
      ).toMatchObject({ cloud: 'aws', adapter: 'aws-bedrock' })
    })
  })

  describe('2026-10-08-credentials-gateway', () => {
    test('copies adapter into gateway on a credential doc missing gateway, keeping adapter for older instances', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'pre-gateway-rename-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'active',
        adapter: 'azure-apim'
      })

      const { modifiedCount } = await findBackfill(
        '2026-10-08-credentials-gateway'
      ).run(db)

      expect(modifiedCount).toBeGreaterThanOrEqual(1)
      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated.gateway).toBe('azure-apim')
      expect(updated.adapter).toBe('azure-apim')
    })

    test('leaves a credential doc that already has a gateway untouched', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'already-gateway-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'active',
        gateway: 'azure-apim'
      })

      await findBackfill('2026-10-08-credentials-gateway').run(db)

      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated.gateway).toBe('azure-apim')
    })

    test('does not give a gateway to a credential doc that never had an adapter', async () => {
      const { insertedId } = await db.collection('credentials').insertOne({
        userId: 'no-adapter-user',
        modelSlug: 'gpt-4o',
        tier: 'research',
        status: 'pending'
      })

      await findBackfill('2026-10-08-credentials-gateway').run(db)

      const updated = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      expect(updated).not.toHaveProperty('gateway')
    })
  })

  describe('2026-10-08-models-hosting-gateway', () => {
    test('replaces flat cloud/adapter with nested hosting and gateway', async () => {
      const { insertedId } = await db.collection('models').insertOne({
        slug: 'backfill-flat-hosting-model',
        cloud: 'azure',
        adapter: 'azure-apim'
      })

      const { modifiedCount } = await findBackfill(
        '2026-10-08-models-hosting-gateway'
      ).run(db)

      expect(modifiedCount).toBeGreaterThanOrEqual(1)
      const updated = await db.collection('models').findOne({ _id: insertedId })
      expect(updated.hosting).toEqual({
        platform: 'foundry',
        cloud: 'azure',
        provider: null
      })
      expect(updated.gateway).toBe('azure-apim')
      expect(updated).not.toHaveProperty('cloud')
      expect(updated).not.toHaveProperty('adapter')
    })

    test('leaves a model doc that already has a gateway untouched', async () => {
      const hosting = { platform: 'direct', cloud: null, provider: 'meta' }
      const { insertedId } = await db.collection('models').insertOne({
        slug: 'backfill-nested-hosting-model',
        hosting,
        gateway: 'azure-apim'
      })

      await findBackfill('2026-10-08-models-hosting-gateway').run(db)

      const updated = await db.collection('models').findOne({ _id: insertedId })
      expect(updated.hosting).toEqual(hosting)
      expect(updated.gateway).toBe('azure-apim')
    })

    test('runs after both flat-field 2026-10-07 backfills and the credentials copy', () => {
      const ids = backfillRegistry.map((backfill) => backfill.id)
      const position = (id) => ids.indexOf(id)
      const credentialsGateway = position('2026-10-08-credentials-gateway')
      const modelsHosting = position('2026-10-08-models-hosting-gateway')
      const modelsFlat = position('2026-10-07-models-cloud-adapter-default')
      const credentialsFlat = position(
        '2026-10-07-credentials-provider-cloud-adapter'
      )

      expect(Math.min(modelsFlat, credentialsFlat)).toBeGreaterThanOrEqual(0)
      expect(credentialsGateway).toBeGreaterThan(modelsFlat)
      expect(credentialsGateway).toBeGreaterThan(credentialsFlat)
      expect(modelsHosting).toBeGreaterThan(credentialsGateway)
      expect(modelsHosting).toBeGreaterThan(modelsFlat)
    })
  })

  describe('2026-10-13-team-deployments-orchestrator', () => {
    test('marks only entries with no orchestrator as mock', async () => {
      const { insertedId } = await db.collection('teamDeployments').insertOne({
        teamId: 'pre-orchestrator-team',
        environment: 'sandbox',
        deployments: [
          { id: 'legacy-entry', status: 'active' },
          { id: 'github-entry', status: 'requested', orchestrator: 'github' }
        ]
      })

      const { modifiedCount } = await findBackfill(
        '2026-10-13-team-deployments-orchestrator'
      ).run(db)

      expect(modifiedCount).toBeGreaterThanOrEqual(1)
      const updated = await db
        .collection('teamDeployments')
        .findOne({ _id: insertedId })
      expect(
        updated.deployments.map((entry) => [entry.id, entry.orchestrator])
      ).toEqual([
        ['legacy-entry', 'mock'],
        ['github-entry', 'github']
      ])
    })
  })

  describe('2026-09-25-consolidate-legacy-team-deployments', () => {
    test('merges legacy one-row-per-model docs into one deployments[] doc, renaming dev to sandbox', async () => {
      const teamId = 'legacy-deployments-team-1'
      // The unique {teamId, environment} index (created at startup, after
      // this backfill in production) would reject two legacy rows sharing
      // a team+environment - drop it to recreate the pre-migration state
      // this backfill exists to clean up, then restore it afterwards.
      await db.collection('teamDeployments').dropIndex('teamId_1_environment_1')

      const requested = await db.collection('teamDeployments').insertOne({
        teamId,
        modelSlug: 'gpt-4o',
        environment: 'dev',
        status: 'requested',
        operationId: 'op-1',
        requestedBy: 'user-1',
        idempotencyKey: 'idem-1',
        createdAt: '2026-09-01T00:00:00.000Z',
        activatedAt: null,
        failureReason: null
      })
      const active = await db.collection('teamDeployments').insertOne({
        teamId,
        modelSlug: 'claude-3-opus',
        environment: 'dev',
        status: 'active',
        operationId: 'op-2',
        requestedBy: 'user-1',
        idempotencyKey: 'idem-2',
        createdAt: '2026-09-02T00:00:00.000Z',
        activatedAt: '2026-09-03T00:00:00.000Z',
        failureReason: null
      })

      const { teamsMigrated, deploymentsMigrated } = await findBackfill(
        '2026-09-25-consolidate-legacy-team-deployments'
      ).run(db)

      await db
        .collection('teamDeployments')
        .createIndex({ teamId: 1, environment: 1 }, { unique: true })

      expect(teamsMigrated).toBeGreaterThanOrEqual(1)
      expect(deploymentsMigrated).toBeGreaterThanOrEqual(2)

      const consolidated = await db
        .collection('teamDeployments')
        .findOne({ teamId, environment: 'sandbox' })

      expect(consolidated.deployments).toHaveLength(2)
      expect(consolidated.gateway.allowedDeployments).toEqual(['claude-3-opus'])
      expect(
        consolidated.deployments.map((entry) => entry.modelSlug).sort()
      ).toEqual(['claude-3-opus', 'gpt-4o'])

      const legacyRemaining = await db
        .collection('teamDeployments')
        .find({ _id: { $in: [requested.insertedId, active.insertedId] } })
        .toArray()
      expect(legacyRemaining).toHaveLength(0)
    })
  })

  describe('2026-09-25-consolidate-legacy-team-credentials', () => {
    test('merges legacy one-per-model team credentials into one canonical doc and seeds the deployment gateway credentialType', async () => {
      const teamId = 'legacy-credentials-team-1'
      await db.collection('teamDeployments').insertOne({
        teamId,
        environment: 'sandbox',
        deployments: [],
        gateway: { credentialType: null, allowedDeployments: [], limits: {} },
        oauthClient: { enabled: false, appRoles: [] },
        createdAt: '2026-09-01T00:00:00.000Z'
      })
      const revoked = await db.collection('credentials').insertOne({
        userId: 'user-1',
        teamId,
        modelSlug: 'gpt-4o',
        tier: 'team',
        environment: 'dev',
        type: 'apim-subscription',
        status: 'revoked',
        idempotencyKey: 'idem-3',
        createdAt: '2026-09-01T00:00:00.000Z',
        renewalCount: 0,
        apimSubscriptionId: 'team-legacy-1-gpt-4o',
        keyHint: 'aaaa',
        expiresAt: '2026-10-01T00:00:00.000Z'
      })
      const active = await db.collection('credentials').insertOne({
        userId: 'user-1',
        teamId,
        modelSlug: 'claude-3-opus',
        tier: 'team',
        environment: 'dev',
        type: 'apim-subscription',
        status: 'active',
        idempotencyKey: 'idem-4',
        createdAt: '2026-09-02T00:00:00.000Z',
        renewalCount: 0,
        apimSubscriptionId: 'team-legacy-1-claude-3-opus',
        keyHint: 'bbbb',
        expiresAt: '2026-10-02T00:00:00.000Z'
      })

      const { teamsMigrated, credentialsRetired } = await findBackfill(
        '2026-09-25-consolidate-legacy-team-credentials'
      ).run(db)

      expect(teamsMigrated).toBeGreaterThanOrEqual(1)
      expect(credentialsRetired).toBeGreaterThanOrEqual(1)

      const canonical = await db
        .collection('credentials')
        .findOne({ _id: active.insertedId })
      expect(canonical.environment).toBe('sandbox')
      expect(canonical.modelSlug).toBeNull()
      expect(canonical.credentialType).toBe('subscription-key')
      expect(canonical.expiresAt).toBeNull()
      expect(canonical.allowedDeployments.sort()).toEqual([
        'claude-3-opus',
        'gpt-4o'
      ])

      const superseded = await db
        .collection('credentials')
        .findOne({ _id: revoked.insertedId })
      expect(superseded).toBeNull()

      const deployment = await db
        .collection('teamDeployments')
        .findOne({ teamId, environment: 'sandbox' })
      expect(deployment.gateway.credentialType).toBe('subscription-key')
    })
  })

  describe('2026-10-14-add-team-slug', () => {
    test('derives a slug for a team created before the field existed', async () => {
      const { insertedId } = await db.collection('teams').insertOne({
        name: 'Legacy Slugless Team',
        normalisedName: 'legacy-slugless-team',
        createdBy: 'legacy-user',
        createdAt: '2026-09-01T00:00:00.000Z'
      })

      const { modifiedCount } = await findBackfill(
        '2026-10-14-add-team-slug'
      ).run(db)

      expect(modifiedCount).toBeGreaterThanOrEqual(1)
      const updated = await db.collection('teams').findOne({ _id: insertedId })
      expect(updated.slug).toBe('legacy-slugless-team')
    })

    test('numbers a derived slug that is already taken and leaves existing slugs alone', async () => {
      await db.collection('teams').insertOne({
        name: 'Rainfall',
        normalisedName: 'rainfall-held',
        slug: 'rainfall',
        createdBy: 'legacy-user',
        createdAt: '2026-09-01T00:00:00.000Z'
      })
      const { insertedId } = await db.collection('teams').insertOne({
        name: 'Rainfall!',
        normalisedName: 'rainfall!',
        createdBy: 'legacy-user',
        createdAt: '2026-09-02T00:00:00.000Z'
      })

      await findBackfill('2026-10-14-add-team-slug').run(db)

      const updated = await db.collection('teams').findOne({ _id: insertedId })
      expect(updated.slug).toBe('rainfall-2')

      const held = await db
        .collection('teams')
        .findOne({ normalisedName: 'rainfall-held' })
      expect(held.slug).toBe('rainfall')
    })
  })

  describe('2026-10-19-team-deployments-oauth-registration', () => {
    const backfillId = '2026-10-19-team-deployments-oauth-registration'

    test('takes the registration from a deployment entry that holds the run report resources', async () => {
      const { insertedId } = await db.collection('teamDeployments').insertOne({
        teamId: 'registered-team',
        environment: 'infradev',
        oauthClient: { enabled: true, appRoles: [] },
        deployments: [
          { id: 'queued-entry', status: 'queued', gitops: null },
          {
            id: 'active-entry',
            status: 'active',
            gitops: {
              resources: {
                registration: {
                  client_id: 'client-1',
                  object_id: 'object-1',
                  service_principal_object_id: 'sp-1',
                  federations: {}
                }
              }
            }
          }
        ]
      })

      await findBackfill(backfillId).run(db)

      const updated = await db
        .collection('teamDeployments')
        .findOne({ _id: insertedId })
      expect(updated.oauthClient).toEqual({
        enabled: true,
        appRoles: [],
        registration: {
          clientId: 'client-1',
          objectId: 'object-1',
          servicePrincipalObjectId: 'sp-1'
        }
      })
    })

    test('sets null where Entra skipped the registration or nothing has verified', async () => {
      const skipped = await db.collection('teamDeployments').insertOne({
        teamId: 'skipped-team',
        environment: 'infradev',
        oauthClient: { enabled: true, appRoles: [] },
        deployments: [
          {
            id: 'skipped',
            status: 'active',
            gitops: { resources: { registration: null } }
          }
        ]
      })
      const bare = await db
        .collection('teamDeployments')
        .insertOne({ teamId: 'bare-team', environment: 'infradev' })

      await findBackfill(backfillId).run(db)

      const [skippedDoc, bareDoc] = await Promise.all([
        db.collection('teamDeployments').findOne({ _id: skipped.insertedId }),
        db.collection('teamDeployments').findOne({ _id: bare.insertedId })
      ])
      expect(skippedDoc.oauthClient.registration).toBeNull()
      expect(bareDoc.oauthClient.registration).toBeNull()
    })

    test('leaves a registration already carried alone', async () => {
      const registration = {
        clientId: 'kept',
        objectId: 'kept',
        servicePrincipalObjectId: 'kept'
      }
      const { insertedId } = await db.collection('teamDeployments').insertOne({
        teamId: 'carried-team',
        environment: 'infradev',
        oauthClient: { enabled: true, appRoles: [], registration },
        deployments: []
      })

      await findBackfill(backfillId).run(db)

      const updated = await db
        .collection('teamDeployments')
        .findOne({ _id: insertedId })
      expect(updated.oauthClient.registration).toEqual(registration)
    })
  })

  describe('2026-10-20-research-credentials-environment', () => {
    const backfillId = '2026-10-20-research-credentials-environment'

    test('sets sandbox on a research credential with a null or missing environment', async () => {
      const [nullEnvironment, missingEnvironment] = await Promise.all(
        [{ environment: null }, {}].map((fields) =>
          db.collection('credentials').insertOne({
            userId: 'legacy-research-user',
            tier: 'research',
            status: 'active',
            ...fields
          })
        )
      )

      const { modifiedCount } = await findBackfill(backfillId).run(db)

      expect(modifiedCount).toBeGreaterThanOrEqual(2)
      const updated = await Promise.all(
        [nullEnvironment, missingEnvironment].map(({ insertedId }) =>
          db.collection('credentials').findOne({ _id: insertedId })
        )
      )
      expect(updated.map((doc) => doc.environment)).toEqual([
        'sandbox',
        'sandbox'
      ])
    })

    test('leaves a team credential and an already-set research environment alone', async () => {
      const team = await db
        .collection('credentials')
        .insertOne({ tier: 'team', status: 'active', environment: null })
      const research = await db.collection('credentials').insertOne({
        tier: 'research',
        status: 'active',
        environment: 'infradev'
      })

      await findBackfill(backfillId).run(db)

      const [teamDoc, researchDoc] = await Promise.all([
        db.collection('credentials').findOne({ _id: team.insertedId }),
        db.collection('credentials').findOne({ _id: research.insertedId })
      ])
      expect(teamDoc.environment).toBeNull()
      expect(researchDoc.environment).toBe('infradev')
    })

    test('is a no-op the second time it runs', async () => {
      await findBackfill(backfillId).run(db)

      await expect(findBackfill(backfillId).run(db)).resolves.toEqual({
        modifiedCount: 0
      })
    })
  })
})
