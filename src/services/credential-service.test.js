import { randomUUID } from 'node:crypto'

// credential-service.js and credential-issuer-registry.js both import
// #/config.js, which snapshots MONGO_URI via convict on first import -
// these must stay dynamic imports loaded from inside beforeAll (after the
// in-memory Mongo server's setup file has set that env var), never static
// top-level imports, or the real server below connects to the wrong URI.
let issueCredential
let rotateCredential
let renewCredential
let revokeCredential
let revealCredential
let credentialIssuerRegistry
let createCredentialIssuerRegistry

async function loadCredentialService() {
  ;({
    issueCredential,
    rotateCredential,
    renewCredential,
    revokeCredential,
    revealCredential
  } = await import('#/services/credential-service.js'))
  ;({ credentialIssuerRegistry, createCredentialIssuerRegistry } =
    await import('#/adapters/credential-issuer-registry.js'))
}

function stubVault(overrides = {}) {
  const secretsByCredentialId = new Map()

  return {
    put: vi.fn(async ({ credentialId, secret }) => {
      secretsByCredentialId.set(credentialId, secret)
    }),
    get: vi.fn(
      async ({ credentialId }) =>
        secretsByCredentialId.get(credentialId) ?? null
    ),
    remove: vi.fn(async ({ credentialId }) => {
      secretsByCredentialId.delete(credentialId)
    }),
    updateExpiry: vi.fn(async () => {}),
    ...overrides
  }
}

describe('#credential-service vault wiring', () => {
  let server
  let db
  let locker

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')
    await loadCredentialService()

    server = await createServer()
    await server.initialize()
    db = server.db
    locker = server.locker
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  test('issueCredential still returns the secret when the vault write fails, flagging vaultState: unwritten', async () => {
    const vault = stubVault({
      put: vi.fn().mockRejectedValue(new Error('vault unavailable'))
    })

    const { credential, secret } = await issueCredential(
      db,
      locker,
      {
        userId: `vault-fail-user-${randomUUID()}`,
        modelSlug: 'gpt-4o',
        idempotencyKey: randomUUID()
      },
      credentialIssuerRegistry,
      vault
    )

    expect(secret).toEqual(expect.any(String))

    const stored = await db
      .collection('credentials')
      .findOne({ _id: credential._id })

    expect(stored.vaultState).toBe('unwritten')
  })

  test('issueCredential writes the secret to the vault and does not set vaultState on success', async () => {
    const vault = stubVault()

    const { credential, secret } = await issueCredential(
      db,
      locker,
      {
        userId: `vault-ok-user-${randomUUID()}`,
        modelSlug: 'gpt-4o',
        idempotencyKey: randomUUID()
      },
      credentialIssuerRegistry,
      vault
    )

    expect(vault.put).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: credential._id.toString(),
        issuerKey: 'mock',
        secret
      })
    )

    const stored = await db
      .collection('credentials')
      .findOne({ _id: credential._id })

    expect(stored.vaultState).toBeUndefined()
  })

  test('issueCredential rejects a model whose adapter is not enabled, without creating a credential', async () => {
    await db.collection('models').insertOne({
      slug: 'bedrock-not-enabled-model',
      eligible: true,
      tiers: ['research'],
      adapter: 'aws-bedrock'
    })
    const userId = `adapter-off-user-${randomUUID()}`
    const liveRegistry = createCredentialIssuerRegistry(
      { mock: credentialIssuerRegistry.forCredential({}).issuer },
      'live'
    )

    await expect(
      issueCredential(
        db,
        locker,
        {
          userId,
          modelSlug: 'bedrock-not-enabled-model',
          idempotencyKey: randomUUID()
        },
        liveRegistry,
        stubVault()
      )
    ).rejects.toMatchObject({
      output: { statusCode: 501 },
      data: { code: 'adapter-not-enabled' }
    })

    expect(await db.collection('credentials').findOne({ userId })).toBeNull()
  })

  test('rotateCredential writes the rotated secret to the vault', async () => {
    const vault = stubVault()
    const userId = `vault-rotate-user-${randomUUID()}`
    const issued = await issueCredential(
      db,
      locker,
      {
        userId,
        modelSlug: 'gpt-4o',
        idempotencyKey: randomUUID()
      },
      credentialIssuerRegistry,
      vault
    )

    const { credential, secret } = await rotateCredential(
      db,
      locker,
      { id: issued.credential._id.toString(), userId },
      credentialIssuerRegistry,
      vault
    )

    await expect(
      vault.get({ credentialId: credential._id.toString() })
    ).resolves.toBe(secret)
  })

  test('revokeCredential removes the secret from the vault', async () => {
    const vault = stubVault()
    const userId = `vault-revoke-user-${randomUUID()}`
    const issued = await issueCredential(
      db,
      locker,
      {
        userId,
        modelSlug: 'gpt-4o',
        idempotencyKey: randomUUID()
      },
      credentialIssuerRegistry,
      vault
    )

    await revokeCredential(
      db,
      locker,
      { id: issued.credential._id.toString(), userId },
      credentialIssuerRegistry,
      vault
    )

    await expect(
      vault.get({ credentialId: issued.credential._id.toString() })
    ).resolves.toBeNull()
  })

  test('revokeCredential does not fail the request when the vault remove fails', async () => {
    const vault = stubVault({
      remove: vi.fn().mockRejectedValue(new Error('vault unavailable'))
    })
    const userId = `vault-revoke-fail-user-${randomUUID()}`
    const issued = await issueCredential(
      db,
      locker,
      {
        userId,
        modelSlug: 'gpt-4o',
        idempotencyKey: randomUUID()
      },
      credentialIssuerRegistry,
      vault
    )

    const revoked = await revokeCredential(
      db,
      locker,
      {
        id: issued.credential._id.toString(),
        userId
      },
      credentialIssuerRegistry,
      vault
    )

    expect(revoked.status).toBe('revoked')
  })

  test('revealCredential returns 404 when the credential is flagged vaultState: unwritten', async () => {
    const vault = stubVault({
      put: vi.fn().mockRejectedValue(new Error('vault unavailable'))
    })
    const userId = `vault-reveal-unwritten-user-${randomUUID()}`
    const issued = await issueCredential(
      db,
      locker,
      {
        userId,
        modelSlug: 'gpt-4o',
        idempotencyKey: randomUUID()
      },
      credentialIssuerRegistry,
      vault
    )

    await expect(
      revealCredential(
        db,
        {
          id: issued.credential._id.toString(),
          actorUserId: userId,
          reason: 'testing'
        },
        vault
      )
    ).rejects.toMatchObject({ output: { statusCode: 404 } })
  })

  test('renewCredential updates the vault secret expiry and clears a prior vaultState: unwritten flag', async () => {
    const userId = `vault-renew-user-${randomUUID()}`
    const failingVault = stubVault({
      put: vi.fn().mockRejectedValue(new Error('vault unavailable'))
    })
    const issued = await issueCredential(
      db,
      locker,
      { userId, modelSlug: 'gpt-4o', idempotencyKey: randomUUID() },
      credentialIssuerRegistry,
      failingVault
    )

    const vault = stubVault()
    const renewed = await renewCredential(
      db,
      locker,
      { id: issued.credential._id.toString(), userId },
      credentialIssuerRegistry,
      vault
    )

    expect(vault.updateExpiry).toHaveBeenCalledWith({
      credentialId: issued.credential._id.toString(),
      issuerKey: 'mock',
      expiresOn: new Date(renewed.expiresAt)
    })

    const stored = await db
      .collection('credentials')
      .findOne({ _id: issued.credential._id })

    expect(stored.vaultState).toBeUndefined()
  })

  test('renewCredential flags vaultState: unwritten when the vault expiry update fails', async () => {
    const vault = stubVault({
      updateExpiry: vi.fn().mockRejectedValue(new Error('vault unavailable'))
    })
    const userId = `vault-renew-fail-user-${randomUUID()}`
    const issued = await issueCredential(
      db,
      locker,
      { userId, modelSlug: 'gpt-4o', idempotencyKey: randomUUID() },
      credentialIssuerRegistry,
      vault
    )

    const renewed = await renewCredential(
      db,
      locker,
      { id: issued.credential._id.toString(), userId },
      credentialIssuerRegistry,
      vault
    )

    expect(renewed.status).toBe('active')

    const stored = await db
      .collection('credentials')
      .findOne({ _id: issued.credential._id })

    expect(stored.vaultState).toBe('unwritten')
  })
})

describe('#credential-service externalGatewaySubscriptionId fallback', () => {
  let server
  let db
  let locker

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')
    await loadCredentialService()

    server = await createServer()
    await server.initialize()
    db = server.db
    locker = server.locker
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  // A document shaped like one written before the 2 Oct 2026 rename - only
  // the old `apimSubscriptionId` field, no `externalGatewaySubscriptionId`.
  async function insertLegacyCredential(userId) {
    const { insertedId } = await db.collection('credentials').insertOne({
      userId,
      modelSlug: 'gpt-4o',
      tier: 'research',
      status: 'active',
      type: 'apim-subscription',
      apimSubscriptionId: `research-${userId}-gpt-4o`,
      keyHint: 'aaaa',
      issuerKey: 'mock',
      renewalCount: 0,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString()
    })

    return insertedId
  }

  test('rotateCredential still resolves the issuer externalId from the legacy apimSubscriptionId field', async () => {
    const userId = `legacy-rotate-user-${randomUUID()}`
    const id = await insertLegacyCredential(userId)

    const { credential } = await rotateCredential(db, locker, {
      id: id.toString(),
      userId
    })

    expect(credential.keyHint).toHaveLength(4)
  })

  test('revokeCredential still resolves the issuer externalId from the legacy apimSubscriptionId field', async () => {
    const userId = `legacy-revoke-user-${randomUUID()}`
    const id = await insertLegacyCredential(userId)

    const revoked = await revokeCredential(db, locker, {
      id: id.toString(),
      userId
    })

    expect(revoked.status).toBe('revoked')
  })
})
