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
let ensureTeamCredential
let teamCredentialNeedsRetry
let credentialIssuerRegistry
let createCredentialIssuerRegistry
let createCredentialVaultRegistry

async function loadCredentialService() {
  ;({
    issueCredential,
    rotateCredential,
    renewCredential,
    revokeCredential,
    revealCredential,
    ensureTeamCredential,
    teamCredentialNeedsRetry
  } = await import('#/services/credential-service.js'))
  ;({ credentialIssuerRegistry, createCredentialIssuerRegistry } =
    await import('#/adapters/credential-issuer-registry.js'))
  ;({ createCredentialVaultRegistry } =
    await import('#/adapters/credential-vault-registry.js'))
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

  test('reconciliation leaves a research issuance alone while its secret is still being stored', async () => {
    const { reconcilePendingCredentials } =
      await import('#/services/maintenance-service.js')
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const vault = stubVault({
      put: vi.fn(async () => {
        await gate
      })
    })
    const reconcileVault = stubVault()
    const userId = `vault-inflight-user-${randomUUID()}`

    const issuing = issueCredential(
      db,
      locker,
      { userId, modelSlug: 'gpt-4o', idempotencyKey: randomUUID() },
      credentialIssuerRegistry,
      vault
    )

    await vi.waitFor(() => expect(vault.put).toHaveBeenCalled())

    const inFlight = await db.collection('credentials').findOne({ userId })

    // Active and marked, secret not stored yet: a sweep now must not reissue it.
    expect(inFlight).toMatchObject({
      status: 'active',
      vaultState: 'unwritten'
    })

    await reconcilePendingCredentials(
      db,
      locker,
      credentialIssuerRegistry,
      reconcileVault
    )

    expect(reconcileVault.put).not.toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: inFlight._id.toString() })
    )

    release()

    const { credential, secret } = await issuing

    expect(vault.put).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: credential._id.toString(),
        secret
      })
    )
    expect(
      (await db.collection('credentials').findOne({ _id: credential._id }))
        .vaultState
    ).toBeUndefined()
  })

  test('issueCredential rejects a model whose gateway is not enabled, without creating a credential', async () => {
    await db.collection('models').insertOne({
      slug: 'other-gateway-not-enabled-model',
      eligible: true,
      tiers: ['research'],
      gateway: 'aws-apigw'
    })
    const userId = `gateway-off-user-${randomUUID()}`
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
          modelSlug: 'other-gateway-not-enabled-model',
          idempotencyKey: randomUUID()
        },
        liveRegistry,
        stubVault()
      )
    ).rejects.toMatchObject({
      output: { statusCode: 501 },
      data: { code: 'gateway-not-enabled' }
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
      environment: 'infradev',
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

  test('a mocked team secret goes to the mock vault while a research secret still reaches the real vault', async () => {
    const mockVault = stubVault()
    const realVault = stubVault()
    const liveIssuer = {
      issue: vi.fn(async () => ({
        externalId: 'sub-1',
        secret: 'live-research-secret',
        keyHint: 'cret',
        expiresAt: new Date(Date.now() + 86400000).toISOString()
      }))
    }
    const registry = createCredentialIssuerRegistry(
      {
        mock: credentialIssuerRegistry.forCredential({}).issuer,
        'azure-apim': liveIssuer
      },
      'live',
      ['team']
    )
    const vault = createCredentialVaultRegistry({
      mock: mockVault,
      'azure-apim': realVault
    })
    const userId = `placeholder-user-${randomUUID()}`
    const teamId = `placeholder-team-${randomUUID()}`

    const team = await ensureTeamCredential(
      db,
      locker,
      {
        teamId,
        environment: 'sandbox',
        modelSlug: 'gpt-4o',
        requestedBy: userId,
        operationId: randomUUID()
      },
      registry,
      vault
    )
    const research = await issueCredential(
      db,
      locker,
      { userId, modelSlug: 'gpt-4o', idempotencyKey: randomUUID() },
      registry,
      vault
    )

    expect(team.created).toBe(true)
    expect(team.credential.issuerKey).toBe('mock')
    expect(mockVault.put).toHaveBeenCalledTimes(1)
    expect(mockVault.put).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: team.credential._id.toString(),
        secret: expect.stringContaining('mock-oauth-')
      })
    )
    expect(research.credential.issuerKey).toBe('azure-apim')
    expect(realVault.put).toHaveBeenCalledTimes(1)
    expect(realVault.put).toHaveBeenCalledWith(
      expect.objectContaining({ secret: 'live-research-secret' })
    )
  })
})

describe('#credential-service ensureTeamCredential', () => {
  let server
  let db
  let locker

  beforeAll(async () => {
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

  function params(overrides = {}) {
    return {
      teamId: `ensure-team-${randomUUID()}`,
      environment: 'sandbox',
      modelSlug: 'gpt-4o',
      requestedBy: `ensure-user-${randomUUID()}`,
      operationId: randomUUID(),
      ...overrides
    }
  }

  test('creates the credential, puts the secret in the vault tagged with the team and environment, and returns no secret', async () => {
    const vault = stubVault()
    const request = params()

    const result = await ensureTeamCredential(
      db,
      locker,
      request,
      credentialIssuerRegistry,
      vault
    )

    expect(result.created).toBe(true)
    expect(result).not.toHaveProperty('secret')
    expect(JSON.stringify(result)).not.toContain('mock-oauth-')
    expect(vault.put).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: result.credential._id.toString(),
        environment: 'sandbox',
        tags: expect.objectContaining({
          'aip-team': request.teamId,
          'aip-environment': 'sandbox'
        })
      })
    )
    expect(
      await db
        .collection('auditEvents')
        .findOne({ resourceId: result.credential._id.toString() })
    ).toMatchObject({
      actorUserId: request.requestedBy,
      action: 'credential.issue',
      outcome: 'success'
    })
  })

  test('does nothing when the team already holds an active credential for the environment', async () => {
    const vault = stubVault()
    const request = params()

    await ensureTeamCredential(
      db,
      locker,
      request,
      credentialIssuerRegistry,
      vault
    )
    const again = await ensureTeamCredential(
      db,
      locker,
      { ...request, modelSlug: 'gpt-5-mini', operationId: randomUUID() },
      credentialIssuerRegistry,
      vault
    )

    expect(again.created).toBe(false)
    expect(vault.put).toHaveBeenCalledTimes(1)
    expect(
      await db
        .collection('credentials')
        .countDocuments({ teamId: request.teamId, tier: 'team' })
    ).toBe(1)
  })

  test('creates a new credential when the earlier one was revoked', async () => {
    const vault = stubVault()
    const request = params()
    const first = await ensureTeamCredential(
      db,
      locker,
      request,
      credentialIssuerRegistry,
      vault
    )

    await db
      .collection('credentials')
      .updateOne({ _id: first.credential._id }, { $set: { status: 'revoked' } })

    const second = await ensureTeamCredential(
      db,
      locker,
      { ...request, operationId: randomUUID() },
      credentialIssuerRegistry,
      vault
    )

    expect(second.created).toBe(true)
    expect(second.credential._id.toString()).not.toBe(
      first.credential._id.toString()
    )
  })

  test('flags the credential vaultState: unwritten and reports vaultWritten: false when the vault write fails, still without returning the secret', async () => {
    const vault = stubVault({
      put: vi.fn().mockRejectedValue(new Error('vault unavailable'))
    })

    const result = await ensureTeamCredential(
      db,
      locker,
      params(),
      credentialIssuerRegistry,
      vault
    )

    expect(result).toMatchObject({ created: true, vaultWritten: false })
    expect(result).not.toHaveProperty('secret')
    expect(
      (
        await db
          .collection('credentials')
          .findOne({ _id: result.credential._id })
      ).vaultState
    ).toBe('unwritten')
  })

  test('marks the credential failed when the issuer fails, then reuses that document on the retry', async () => {
    const request = params()
    const failing = {
      forModel: () => ({
        issuerKey: 'mock',
        issuer: {
          issue: vi.fn().mockRejectedValue(new Error('issuer unavailable'))
        }
      })
    }

    await expect(
      ensureTeamCredential(db, locker, request, failing, stubVault())
    ).rejects.toMatchObject({
      output: { statusCode: 502 },
      data: { code: 'upstream-unavailable' }
    })

    const failed = await db
      .collection('credentials')
      .find({ teamId: request.teamId, tier: 'team' })
      .toArray()

    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      status: 'failed',
      failureReason: 'issuer-error'
    })
    expect(await teamCredentialNeedsRetry(db, request)).toBe(true)

    const retried = await ensureTeamCredential(
      db,
      locker,
      { ...request, operationId: randomUUID() },
      credentialIssuerRegistry,
      stubVault()
    )

    expect(retried.credential._id.toString()).toBe(failed[0]._id.toString())
    expect(retried.credential.status).toBe('active')
    expect(await teamCredentialNeedsRetry(db, request)).toBe(false)
    expect(
      await db
        .collection('credentials')
        .countDocuments({ teamId: request.teamId, tier: 'team' })
    ).toBe(1)
  })

  test('is refused as gateway-not-enabled when no issuer serves the team tier, recording the attempt so a later poll can retry it', async () => {
    const request = params()
    const live = createCredentialIssuerRegistry({}, 'live', [])

    await expect(
      ensureTeamCredential(db, locker, request, live, stubVault())
    ).rejects.toMatchObject({
      output: { statusCode: 501 },
      data: { code: 'gateway-not-enabled' }
    })

    const [recorded] = await db
      .collection('credentials')
      .find({ teamId: request.teamId })
      .toArray()

    expect(recorded).toMatchObject({
      tier: 'team',
      status: 'failed',
      failureReason: 'gateway-not-enabled',
      issuerKey: null
    })
    expect(await teamCredentialNeedsRetry(db, request)).toBe(true)

    // The issuer is enabled later: the same document is reused and activated.
    const retried = await ensureTeamCredential(
      db,
      locker,
      { ...request, operationId: randomUUID() },
      credentialIssuerRegistry,
      stubVault()
    )

    expect(retried.credential._id.toString()).toBe(recorded._id.toString())
    expect(retried.credential).toMatchObject({
      status: 'active',
      issuerKey: 'mock'
    })
    expect(
      await db
        .collection('credentials')
        .countDocuments({ teamId: request.teamId })
    ).toBe(1)
    expect(await teamCredentialNeedsRetry(db, request)).toBe(false)
  })

  test('records a repeated attempt that never reached an issuer on the same document, whatever the model or error', async () => {
    const request = params({ modelSlug: 'a-model-not-in-the-catalogue' })
    const broken = {
      forModel: () => {
        throw new Error('registry unavailable')
      }
    }

    await expect(
      ensureTeamCredential(db, locker, request, broken, stubVault())
    ).rejects.toThrow('registry unavailable')
    await expect(
      ensureTeamCredential(db, locker, request, broken, stubVault())
    ).rejects.toThrow('registry unavailable')

    const recorded = await db
      .collection('credentials')
      .find({ teamId: request.teamId })
      .toArray()

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      status: 'failed',
      failureReason: 'issuer-unavailable',
      cloud: null,
      gateway: null
    })
  })

  test('a retry that raced another poll for the lock does not repeat an attempt that has just failed', async () => {
    const request = params()
    const issue = vi.fn().mockRejectedValue(new Error('issuer unavailable'))
    const failing = {
      forModel: () => ({ issuerKey: 'mock', issuer: { issue } })
    }
    const stalled = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    await db.collection('credentials').insertOne({
      teamId: request.teamId,
      environment: 'sandbox',
      tier: 'team',
      credentialType: 'oauth',
      status: 'failed',
      createdAt: stalled
    })

    const polls = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        ensureTeamCredential(
          db,
          locker,
          { ...request, retryAfterMs: 60000 },
          failing,
          stubVault()
        )
      )
    )

    // Only the poll that got the lock first calls the issuer; the others find
    // the attempt they read as stalled has just been retried.
    expect(issue).toHaveBeenCalledTimes(1)
    expect(polls.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(
      polls.filter(
        ({ status, value }) =>
          status === 'fulfilled' && value.credential === null
      )
    ).toHaveLength(3)
  })

  test('a retry creates the credential when it is still needed, and a new activation is never throttled', async () => {
    const retried = params()
    const activated = params()

    const fromPoll = await ensureTeamCredential(
      db,
      locker,
      { ...retried, retryAfterMs: 60000 },
      credentialIssuerRegistry,
      stubVault()
    )
    await db.collection('credentials').insertOne({
      teamId: activated.teamId,
      environment: 'sandbox',
      tier: 'team',
      credentialType: 'oauth',
      status: 'failed',
      createdAt: new Date().toISOString()
    })
    const fromActivation = await ensureTeamCredential(
      db,
      locker,
      activated,
      credentialIssuerRegistry,
      stubVault()
    )

    expect(fromPoll).toMatchObject({ created: true })
    expect(fromPoll.credential.status).toBe('active')
    expect(fromActivation).toMatchObject({ created: true })
    expect(fromActivation.credential.status).toBe('active')
  })

  test('a poll retrying an attempt cannot overwrite a revocation that raced it', async () => {
    const request = params()
    const { insertedId } = await db.collection('credentials').insertOne({
      teamId: request.teamId,
      environment: 'sandbox',
      tier: 'team',
      credentialType: 'oauth',
      status: 'failed',
      userId: request.requestedBy,
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    })
    const id = insertedId.toString()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const issue = vi.fn(async () => {
      await gate

      return {
        externalId: 'team-x',
        secret: 'mock-oauth-abcd',
        keyHint: 'abcd'
      }
    })
    const slow = {
      forModel: () => ({ issuerKey: 'mock', issuer: { issue } })
    }

    const retry = ensureTeamCredential(
      db,
      locker,
      { ...request, retryAfterMs: 60000 },
      slow,
      stubVault()
    )

    await vi.waitFor(() => expect(issue).toHaveBeenCalled())

    // The revocation cannot slip in while the row is being reissued.
    await expect(
      revokeCredential(db, locker, { id, userId: request.requestedBy })
    ).rejects.toThrow('Failed to acquire lock')

    release()

    expect((await retry).credential).toMatchObject({ status: 'active' })
  })

  test('an unfinished attempt revoked before it is reissued is left revoked and a new document is made', async () => {
    const request = params()
    const { insertedId } = await db.collection('credentials').insertOne({
      teamId: request.teamId,
      environment: 'sandbox',
      tier: 'team',
      credentialType: 'oauth',
      status: 'failed',
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    })
    const realLock = locker.lock.bind(locker)
    const spy = vi
      .spyOn(locker, 'lock')
      .mockImplementation(async (resource) => {
        if (resource === `credential:${insertedId}`) {
          // The revocation wins the race for the row after it was read.
          await db
            .collection('credentials')
            .updateOne({ _id: insertedId }, { $set: { status: 'revoked' } })
        }

        return realLock(resource)
      })

    try {
      const { credential } = await ensureTeamCredential(
        db,
        locker,
        request,
        credentialIssuerRegistry,
        stubVault()
      )

      expect(credential._id.toString()).not.toBe(insertedId.toString())
      expect(credential.status).toBe('active')
    } finally {
      spy.mockRestore()
    }

    expect(
      (await db.collection('credentials').findOne({ _id: insertedId })).status
    ).toBe('revoked')
  })

  test('a first issuance cannot be revoked and then overwritten as active while it is still running', async () => {
    const request = params()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const issue = vi.fn(async () => {
      await gate

      return {
        externalId: 'team-x',
        secret: 'mock-oauth-abcd',
        keyHint: 'abcd'
      }
    })
    const slow = {
      forModel: () => ({ issuerKey: 'mock', issuer: { issue } })
    }

    const first = ensureTeamCredential(db, locker, request, slow, stubVault())

    await vi.waitFor(() => expect(issue).toHaveBeenCalled())

    // The pending row is already visible, but no admin can revoke it yet.
    const row = await db
      .collection('credentials')
      .findOne({ teamId: request.teamId })

    expect(row.status).toBe('pending')
    await expect(
      revokeCredential(db, locker, {
        id: row._id.toString(),
        userId: request.requestedBy
      })
    ).rejects.toThrow('Failed to acquire lock')

    release()

    expect((await first).credential).toMatchObject({ status: 'active' })
  })

  test('stores the vault marker with the activation, so a stop before the vault write leaves it for reconciliation', async () => {
    const request = params()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const vault = stubVault({
      put: vi.fn(async () => {
        await gate
      })
    })

    const creating = ensureTeamCredential(
      db,
      locker,
      request,
      credentialIssuerRegistry,
      vault
    )

    await vi.waitFor(() => expect(vault.put).toHaveBeenCalled())

    // Active, secret not in the vault yet: marked, so reconciliation finds it.
    expect(
      await db
        .collection('credentials')
        .findOne({ teamId: request.teamId, status: 'active' })
    ).toMatchObject({ vaultState: 'unwritten' })

    release()

    const { credential, vaultWritten } = await creating

    expect(vaultWritten).toBe(true)
    expect(credential.vaultState).toBeUndefined()
    expect(
      (await db.collection('credentials').findOne({ _id: credential._id }))
        .vaultState
    ).toBeUndefined()
  })

  test('recovery on an older activation reuses a newer failed row without clashing with the idempotency key of the revoked one', async () => {
    const request = params()
    const activationA = { ...request, operationId: `op-a-${randomUUID()}` }
    const activationB = {
      ...request,
      modelSlug: 'gpt-5-mini',
      operationId: `op-b-${randomUUID()}`
    }
    const failing = {
      forModel: () => ({
        issuerKey: 'mock',
        issuer: { issue: vi.fn().mockRejectedValue(new Error('unavailable')) }
      })
    }

    // Model A's credential, then revoked; model B's activation then fails.
    const first = await ensureTeamCredential(
      db,
      locker,
      activationA,
      credentialIssuerRegistry,
      stubVault()
    )

    await db.collection('credentials').updateOne(
      { _id: first.credential._id },
      {
        $set: {
          status: 'revoked',
          revokedAt: new Date(Date.now() - 1000).toISOString()
        }
      }
    )
    await expect(
      ensureTeamCredential(db, locker, activationB, failing, stubVault())
    ).rejects.toMatchObject({ output: { statusCode: 502 } })

    // Recovery is made for the first active deployment, model A.
    const recovered = await ensureTeamCredential(
      db,
      locker,
      { ...activationA, retryAfterMs: 0 },
      credentialIssuerRegistry,
      stubVault()
    )

    expect(recovered.created).toBe(true)
    expect(recovered.credential.status).toBe('active')
    expect(recovered.credential.idempotencyKey).toBe(
      `team-activation:${activationB.operationId}`
    )
    expect(recovered.credential._id.toString()).not.toBe(
      first.credential._id.toString()
    )
  })

  test('a newer activation whose issuance never started is owed a credential even though an older one was revoked', async () => {
    const request = params()
    const minutesAgo = (minutes) =>
      new Date(Date.now() - minutes * 60 * 1000).toISOString()
    const { insertedId } = await db.collection('credentials').insertOne({
      teamId: request.teamId,
      environment: 'sandbox',
      tier: 'team',
      credentialType: 'oauth',
      status: 'revoked',
      createdAt: minutesAgo(120),
      revokedAt: minutesAgo(60)
    })

    // Activated after the revocation: its credential was never made.
    expect(
      await teamCredentialNeedsRetry(db, request, {
        activatedAt: minutesAgo(30)
      })
    ).toBe(true)
    // Activated before the revocation: the admin revoked it deliberately.
    expect(
      await teamCredentialNeedsRetry(db, request, {
        activatedAt: minutesAgo(90)
      })
    ).toBe(false)
    expect(await teamCredentialNeedsRetry(db, request)).toBe(false)

    const owed = await ensureTeamCredential(
      db,
      locker,
      { ...request, retryAfterMs: 0, activatedAt: minutesAgo(30) },
      credentialIssuerRegistry,
      stubVault()
    )
    const deliberate = await ensureTeamCredential(
      db,
      locker,
      {
        ...request,
        retryAfterMs: 0,
        activatedAt: minutesAgo(90)
      },
      credentialIssuerRegistry,
      stubVault()
    )

    expect(owed.created).toBe(true)
    expect(owed.credential._id.toString()).not.toBe(insertedId.toString())
    // Now the team has an active credential, so a poll adds nothing more.
    expect(deliberate).toMatchObject({ created: false })
    expect(
      (await db.collection('credentials').findOne({ _id: insertedId })).status
    ).toBe('revoked')
  })

  test('an initial grant delayed past an admin’s revocation does not replace the credential, but an activation after it does', async () => {
    const request = params()
    const minutesAgo = (minutes) =>
      new Date(Date.now() - minutes * 60 * 1000).toISOString()

    await db.collection('credentials').insertOne({
      teamId: request.teamId,
      environment: 'sandbox',
      tier: 'team',
      credentialType: 'oauth',
      status: 'revoked',
      createdAt: minutesAgo(120),
      revokedAt: minutesAgo(30)
    })

    // Activated (60 minutes ago), then revoked (30), before the grant ran.
    const delayed = await ensureTeamCredential(
      db,
      locker,
      { ...request, activatedAt: minutesAgo(60) },
      credentialIssuerRegistry,
      stubVault()
    )

    expect(delayed).toEqual({ credential: null, created: false })
    expect(
      await db
        .collection('credentials')
        .countDocuments({ teamId: request.teamId, status: 'active' })
    ).toBe(0)

    // Activated (10 minutes ago) after the revocation: its credential is owed.
    const owed = await ensureTeamCredential(
      db,
      locker,
      { ...request, activatedAt: minutesAgo(10) },
      credentialIssuerRegistry,
      stubVault()
    )

    expect(owed.created).toBe(true)
  })

  test('reuses a pending attempt a crash left behind rather than adding a second document', async () => {
    const request = params()
    const { insertedId } = await db.collection('credentials').insertOne({
      teamId: request.teamId,
      environment: 'sandbox',
      tier: 'team',
      credentialType: 'oauth',
      status: 'pending',
      userId: request.requestedBy,
      idempotencyKey: 'team-activation:crashed',
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    })

    expect(await teamCredentialNeedsRetry(db, request)).toBe(true)

    const { credential } = await ensureTeamCredential(
      db,
      locker,
      request,
      credentialIssuerRegistry,
      stubVault()
    )

    expect(credential._id.toString()).toBe(insertedId.toString())
    expect(credential.status).toBe('active')
    expect(
      await db
        .collection('credentials')
        .countDocuments({ teamId: request.teamId })
    ).toBe(1)
  })

  test('says a poll needs to retry only when nothing is active and nothing is recorded or an attempt stalled', async () => {
    const request = params()
    const held = (status, createdAt) => ({
      teamId: request.teamId,
      environment: 'sandbox',
      tier: 'team',
      credentialType: 'oauth',
      status,
      createdAt
    })
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const retryAfterMs = 60000

    expect(await teamCredentialNeedsRetry(db, request)).toBe(true)

    // A failed attempt inside the wait is left alone, then retried.
    const { insertedId } = await db
      .collection('credentials')
      .insertOne(held('failed', new Date().toISOString()))

    expect(await teamCredentialNeedsRetry(db, request, { retryAfterMs })).toBe(
      false
    )

    await db
      .collection('credentials')
      .updateOne({ _id: insertedId }, { $set: { createdAt: anHourAgo } })

    expect(await teamCredentialNeedsRetry(db, request, { retryAfterMs })).toBe(
      true
    )

    // An admin's revoked credential is not recreated by a poll.
    await db
      .collection('credentials')
      .updateOne({ _id: insertedId }, { $set: { status: 'revoked' } })

    expect(await teamCredentialNeedsRetry(db, request)).toBe(false)

    // An active one is never retried.
    await db.collection('credentials').insertOne(held('active', anHourAgo))
    await db.collection('credentials').insertOne(held('failed', anHourAgo))

    expect(await teamCredentialNeedsRetry(db, request)).toBe(false)
  })

  test('judges a poll retry by the latest attempt, so an old failure never undoes a later revocation', async () => {
    const request = params()
    const held = (status, minutesAgo) => ({
      teamId: request.teamId,
      environment: 'sandbox',
      tier: 'team',
      credentialType: 'oauth',
      status,
      createdAt: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString()
    })

    // An older failed row beside a newer, revoked credential: left alone.
    await db.collection('credentials').insertOne(held('failed', 120))
    await db.collection('credentials').insertOne(held('revoked', 60))

    expect(await teamCredentialNeedsRetry(db, request)).toBe(false)

    // A later activation's attempt that failed is retried.
    await db.collection('credentials').insertOne(held('failed', 30))

    expect(await teamCredentialNeedsRetry(db, request)).toBe(true)
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

describe('#credential-service research environment', () => {
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

  // The credential's own environment, as if issued before the portal moved.
  async function insertCredential({ userId, environment }) {
    const { insertedId } = await db.collection('credentials').insertOne({
      userId,
      modelSlug: 'gpt-4o',
      tier: 'research',
      status: 'active',
      type: 'apim-subscription',
      externalGatewaySubscriptionId: `research-${userId}-gpt-4o`,
      keyHint: 'aaaa',
      issuerKey: 'mock',
      renewalCount: 0,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      ...(environment !== undefined && { environment })
    })

    return insertedId.toString()
  }

  function spyRegistry() {
    const issuer = {
      renew: vi.fn(async ({ externalId }) => ({ externalId })),
      rotate: vi.fn(async ({ externalId }) => ({
        externalId,
        secret: 'rotated-secret',
        keyHint: 'cret'
      })),
      revoke: vi.fn(async ({ externalId }) => ({ externalId }))
    }

    return { issuer, registry: { forCredential: () => ({ issuer }) } }
  }

  test('a research key is issued into the configured research environment and says so', async () => {
    const vault = stubVault()
    const userId = `env-default-user-${randomUUID()}`

    const { credential } = await issueCredential(
      db,
      locker,
      { userId, modelSlug: 'gpt-4o', idempotencyKey: randomUUID() },
      credentialIssuerRegistry,
      vault
    )

    expect(credential.environment).toBe('infradev')
    expect(vault.put).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'infradev',
        tags: expect.objectContaining({ 'aip-environment': 'infradev' })
      })
    )
  })

  test('accepts the configured environment named explicitly, refuses any other', async () => {
    const userId = `env-named-user-${randomUUID()}`

    const { credential } = await issueCredential(
      db,
      locker,
      {
        userId,
        modelSlug: 'gpt-4o',
        environment: 'infradev',
        idempotencyKey: randomUUID()
      },
      credentialIssuerRegistry,
      stubVault()
    )

    expect(credential.environment).toBe('infradev')

    await expect(
      issueCredential(
        db,
        locker,
        {
          userId: `env-other-user-${randomUUID()}`,
          modelSlug: 'gpt-4o',
          environment: 'sandbox',
          idempotencyKey: randomUUID()
        },
        credentialIssuerRegistry,
        stubVault()
      )
    ).rejects.toMatchObject({
      output: { statusCode: 403 },
      data: { code: 'environment-not-available' }
    })
  })

  test('renew, rotate, revoke and reveal act on the credential environment, not the configured one', async () => {
    const userId = `env-seam-user-${randomUUID()}`
    const id = await insertCredential({ userId, environment: 'sandbox' })
    const { issuer, registry } = spyRegistry()
    const vault = stubVault()
    await vault.put({ credentialId: id, secret: 'stored-secret' })

    await renewCredential(db, locker, { id, userId }, registry, vault)
    await rotateCredential(db, locker, { id, userId }, registry, vault)
    await revealCredential(
      db,
      { id, actorUserId: userId, reason: 'testing' },
      vault
    )
    await revokeCredential(db, locker, { id, userId }, registry, vault)

    expect(issuer.renew).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'sandbox' })
    )
    expect(issuer.rotate).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'sandbox' })
    )
    expect(issuer.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'sandbox' })
    )

    for (const method of ['updateExpiry', 'put', 'get', 'remove']) {
      expect(vault[method]).toHaveBeenCalledWith(
        expect.objectContaining({ environment: 'sandbox' })
      )
    }

    expect(vault.put).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tags: expect.objectContaining({ 'aip-environment': 'sandbox' })
      })
    )
  })

  test.each([null, undefined])(
    'a research credential with environment %s is treated as sandbox until the backfill has run',
    async (environment) => {
      const userId = `env-legacy-user-${randomUUID()}`
      const id = await insertCredential({ userId, environment })
      const { issuer, registry } = spyRegistry()

      await revokeCredential(db, locker, { id, userId }, registry, stubVault())

      expect(issuer.revoke).toHaveBeenCalledWith(
        expect.objectContaining({ environment: 'sandbox' })
      )
    }
  )

  test('revoking a credential whose environment is not configured fails and leaves it active', async () => {
    const userId = `env-missing-user-${randomUUID()}`
    const id = await insertCredential({ userId, environment: 'gone' })
    const failure = Object.assign(
      new Error('Environment "gone" is not configured in AIP_ENVIRONMENTS'),
      { code: 'environment-not-configured' }
    )
    const registry = {
      forCredential: () => ({
        issuer: { revoke: vi.fn().mockRejectedValue(failure) }
      })
    }

    await expect(
      revokeCredential(db, locker, { id, userId }, registry, stubVault())
    ).rejects.toThrow('is not configured')

    const stored = await db
      .collection('credentials')
      .findOne({ userId, status: { $exists: true } })

    expect(stored.status).toBe('active')
  })
})
