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
})
