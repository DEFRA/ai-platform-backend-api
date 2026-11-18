import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

// What a Platform Admin's block on a team's credentials in one environment
// does to the paths that create, show or change a team credential (P1-AC8).
describe('credential block effects', () => {
  let server
  let db
  let locker
  let grants
  let lifecycle
  let block

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
    locker = server.locker
    grants = await import('#/services/team-credential-grant.js')
    lifecycle = await import('#/services/credential-lifecycle.js')
    block = await import('#/services/credential-block.js')
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  const admin = { userId: 'platform-admin-1' }

  async function teamDocument({
    environment = 'sandbox',
    blocked = false
  } = {}) {
    const doc = {
      teamId: `effects-team-${randomUUID()}`,
      environment,
      deployments: [
        {
          id: randomUUID(),
          modelSlug: 'gpt-4o',
          status: 'active',
          operationId: randomUUID(),
          requestedBy: 'requester-1',
          activatedAt: new Date().toISOString()
        }
      ]
    }

    await db.collection('teamDeployments').insertOne(doc)

    if (blocked) {
      await block.blockCredentials(db, { ...doc, actor: admin })
    }

    return doc
  }

  function settings(fields = {}) {
    return {
      ensureCredential: vi.fn().mockResolvedValue({ created: true }),
      locker,
      logger: { warn: vi.fn(), debug: vi.fn() },
      retryAfterMs: 0,
      ...fields
    }
  }

  async function auditEventsFor(teamId) {
    return db.collection('auditEvents').find({ teamId }).toArray()
  }

  describe('creating a credential', () => {
    test('model activation in a blocked environment issues nothing and writes no event', async () => {
      const doc = await teamDocument({ blocked: true })
      const deps = settings()

      const created = await grants.grantTeamCredential(
        db,
        doc,
        doc.deployments[0],
        deps
      )

      expect(created).toBe(false)
      expect(deps.ensureCredential).not.toHaveBeenCalled()
      expect(deps.logger.warn).not.toHaveBeenCalled()
      expect(deps.logger.debug).toHaveBeenCalledTimes(1)
      expect(await auditEventsFor(doc.teamId)).toEqual([])
    })

    test('the operation runtime’s grant skips a blocked environment as well', async () => {
      const doc = await teamDocument({ blocked: true })
      const deps = settings()
      const grantCredentials = grants.createCredentialGranter({ db, ...deps })

      await grantCredentials({
        teamId: doc.teamId,
        environment: doc.environment,
        items: [{ entryId: doc.deployments[0].id, change: 'add' }]
      })

      expect(deps.ensureCredential).not.toHaveBeenCalled()
    })

    test('a retry skips a blocked environment', async () => {
      const doc = await teamDocument({ blocked: true })
      const deps = settings()

      const created = await grants.retryTeamCredential(db, doc, deps)

      expect(created).toBe(false)
      expect(deps.ensureCredential).not.toHaveBeenCalled()
    })

    test('the recovery sweep skips a blocked environment and still serves an unblocked one', async () => {
      const blocked = await teamDocument({ blocked: true })
      const open = await teamDocument()
      const deps = settings()

      await grants.recoverTeamCredentials(db, deps)

      const teams = deps.ensureCredential.mock.calls.map(
        ([, , params]) => params.teamId
      )

      expect(teams).not.toContain(blocked.teamId)
      expect(teams).toContain(open.teamId)
    })

    test('a block landing after the team’s document was read is honoured', async () => {
      const doc = await teamDocument()
      const staleRead = { ...doc }
      const deps = settings()

      await block.blockCredentials(db, { ...doc, actor: admin })

      const created = await grants.grantTeamCredential(
        db,
        staleRead,
        doc.deployments[0],
        deps
      )

      expect(created).toBe(false)
      expect(deps.ensureCredential).not.toHaveBeenCalled()
    })

    test('a grant that finds the block being changed leaves the credential to the next sweep', async () => {
      const doc = await teamDocument()
      const deps = settings()
      const held = await locker.lock(
        block.credentialsBlockLockName(doc.teamId, doc.environment)
      )

      const created = await grants.grantTeamCredential(
        db,
        doc,
        doc.deployments[0],
        deps
      )

      await held.free()

      expect(created).toBe(false)
      expect(deps.ensureCredential).not.toHaveBeenCalled()
    })

    test('an environment that is not blocked still gets its credential, whatever another environment of the team is', async () => {
      const blocked = await teamDocument({ blocked: true })
      const open = await teamDocument({ environment: 'development' })
      const deps = settings()

      const created = await grants.grantTeamCredential(
        db,
        { ...open, teamId: blocked.teamId },
        open.deployments[0],
        deps
      )

      expect(created).toBe(true)
      expect(deps.ensureCredential).toHaveBeenCalledTimes(1)
    })

    test('the block lock is free again after a grant, a refusal and a failed issue', async () => {
      const doc = await teamDocument()
      const name = block.credentialsBlockLockName(doc.teamId, doc.environment)

      await grants.grantTeamCredential(
        db,
        doc,
        doc.deployments[0],
        settings({
          ensureCredential: vi.fn().mockRejectedValue(new Error('issuer down'))
        })
      )

      const free = await locker.lock(name)

      expect(free).not.toBeNull()

      await free.free()
    })
  })

  describe('rotating, revealing and revoking a team credential', () => {
    function stubVault() {
      const secrets = new Map()

      return {
        put: vi.fn(async ({ credentialId, secret }) => {
          secrets.set(credentialId, secret)
        }),
        get: vi.fn(async ({ credentialId }) => secrets.get(credentialId)),
        remove: vi.fn(async () => {}),
        updateExpiry: vi.fn(async () => {})
      }
    }

    function stubRegistry() {
      const issuer = {
        rotate: vi
          .fn()
          .mockResolvedValue({ keyHint: 'wxyz', secret: 'new-secret' }),
        revoke: vi.fn().mockResolvedValue(undefined)
      }

      return {
        issuer,
        registry: { forCredential: vi.fn(() => ({ issuer })) }
      }
    }

    async function teamCredential(doc, fields = {}) {
      const userId = `team-admin-${randomUUID()}`
      const record = {
        userId,
        teamId: doc.teamId,
        environment: doc.environment,
        tier: 'team',
        credentialType: 'oauth',
        status: 'active',
        externalGatewaySubscriptionId: `ext-${randomUUID()}`,
        issuerKey: 'mock',
        keyHint: 'abcd',
        createdAt: new Date().toISOString(),
        ...fields
      }
      const { insertedId } = await db
        .collection('credentials')
        .insertOne(record)

      await db.collection('teamMembers').insertOne({
        teamId: doc.teamId,
        userId,
        role: 'admin',
        status: 'active'
      })

      return { id: insertedId.toString(), actor: { userId } }
    }

    function eventsOf(doc, action) {
      return db
        .collection('auditEvents')
        .find({ teamId: doc.teamId, action })
        .toArray()
    }

    test('rotate is refused 409 credentials-disabled while the environment is blocked, audited, with no issuer or vault call', async () => {
      const doc = await teamDocument({ blocked: true })
      const { id, actor } = await teamCredential(doc)
      const { issuer, registry } = stubRegistry()
      const vault = stubVault()

      await expect(
        lifecycle.rotateCredential(db, locker, { id, actor }, registry, vault)
      ).rejects.toMatchObject({
        output: { statusCode: 409 },
        data: { code: 'credentials-disabled' }
      })

      expect(issuer.rotate).not.toHaveBeenCalled()
      expect(vault.put).not.toHaveBeenCalled()

      const [event, ...others] = await eventsOf(doc, 'credential.rotate')

      expect(others).toEqual([])
      expect(event).toMatchObject({
        outcome: 'failure',
        code: 'credentials-disabled',
        resource: 'credential',
        resourceId: id,
        teamId: doc.teamId,
        environment: doc.environment,
        role: 'admin',
        reason: null
      })
    })

    test('reveal is refused 409 credentials-disabled while the environment is blocked, audited, and reads no secret', async () => {
      const doc = await teamDocument({ blocked: true })
      const { id, actor } = await teamCredential(doc)
      const vault = stubVault()

      await expect(
        lifecycle.revealCredential(
          db,
          locker,
          { id, actor, reason: 'Needs to share it' },
          vault
        )
      ).rejects.toMatchObject({
        output: { statusCode: 409 },
        data: { code: 'credentials-disabled' }
      })

      expect(vault.get).not.toHaveBeenCalled()

      const [event] = await eventsOf(doc, 'credential.reveal')

      expect(event).toMatchObject({
        outcome: 'failure',
        code: 'credentials-disabled',
        teamId: doc.teamId,
        environment: doc.environment,
        reason: null
      })
      expect(await eventsOf(doc, 'credential.reveal')).toHaveLength(1)
    })

    test('the refusal says nothing of why the credentials are disabled', async () => {
      const doc = await teamDocument({ blocked: true })
      const { id, actor } = await teamCredential(doc)
      const { registry } = stubRegistry()

      const error = await lifecycle
        .rotateCredential(db, locker, { id, actor }, registry, stubVault())
        .catch((caught) => caught)

      expect(error.output.payload.message).toBe(
        'Credentials are disabled for this team in this environment'
      )
      expect(JSON.stringify(error.output.payload)).not.toMatch(/admin|reason/i)
    })

    test('a person who is not a team admin still gets the authorisation refusal, not the block', async () => {
      const doc = await teamDocument({ blocked: true })
      const { id } = await teamCredential(doc)
      const { registry } = stubRegistry()

      await expect(
        lifecycle.rotateCredential(
          db,
          locker,
          { id, actor: { userId: 'stranger' } },
          registry,
          stubVault()
        )
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
    })

    test('rotate and reveal work in an environment that is not blocked', async () => {
      const doc = await teamDocument()
      const { id, actor } = await teamCredential(doc)
      const { registry } = stubRegistry()
      const vault = stubVault()

      const rotated = await lifecycle.rotateCredential(
        db,
        locker,
        { id, actor },
        registry,
        vault
      )

      expect(rotated.secret).toBe('new-secret')
      await expect(
        lifecycle.revealCredential(
          db,
          locker,
          { id, actor, reason: 'Share' },
          vault
        )
      ).resolves.toBe('new-secret')
    })

    test('rotate and reveal of an id that matches nothing are a 404, with no issuer or vault call', async () => {
      const { actor } = await teamCredential(await teamDocument())
      const id = new ObjectId().toString()
      const { issuer, registry } = stubRegistry()
      const vault = stubVault()

      await expect(
        lifecycle.rotateCredential(db, locker, { id, actor }, registry, vault)
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
      await expect(
        lifecycle.revealCredential(
          db,
          locker,
          { id, actor, reason: 'Share' },
          vault
        )
      ).rejects.toMatchObject({ output: { statusCode: 404 } })

      expect(issuer.rotate).not.toHaveBeenCalled()
      expect(vault.get).not.toHaveBeenCalled()
    })

    // A locker whose every lock is taken just before the credential is deleted.
    function lockerThatRemoves(id) {
      return {
        lock: async (name) => {
          const held = await locker.lock(name)

          await db
            .collection('credentials')
            .deleteOne({ _id: new ObjectId(id) })

          return held
        }
      }
    }

    test('a rotate of a credential that is gone once the locks are held is a 404 and calls no issuer', async () => {
      const { id, actor } = await teamCredential(await teamDocument())
      const { issuer, registry } = stubRegistry()
      const vault = stubVault()

      await expect(
        lifecycle.rotateCredential(
          db,
          lockerThatRemoves(id),
          { id, actor },
          registry,
          vault
        )
      ).rejects.toMatchObject({ output: { statusCode: 404 } })

      expect(issuer.rotate).not.toHaveBeenCalled()
    })

    test('a reveal of a credential that is gone once the locks are held is a 404 and reads no secret', async () => {
      const { id, actor } = await teamCredential(await teamDocument())
      const vault = stubVault()

      await expect(
        lifecycle.revealCredential(
          db,
          lockerThatRemoves(id),
          { id, actor, reason: 'Share' },
          vault
        )
      ).rejects.toMatchObject({ output: { statusCode: 404 } })

      expect(vault.get).not.toHaveBeenCalled()
    })

    describe.each([
      [
        'rotate',
        (credential, { registry, vault }) =>
          lifecycle.rotateCredential(db, locker, credential, registry, vault),
        ({ issuer }) => issuer.rotate
      ],
      [
        'reveal',
        (credential, { vault }) =>
          lifecycle.revealCredential(
            db,
            locker,
            { ...credential, reason: 'Share' },
            vault
          ),
        (_deps, vault) => vault.get
      ]
    ])('%s and a Disable at the same moment', (name, act, secretCall) => {
      async function setUp() {
        const doc = await teamDocument()
        const credential = await teamCredential(doc)
        const deps = { ...stubRegistry(), vault: stubVault() }

        await deps.vault.put({
          credentialId: credential.id,
          secret: 'held-secret'
        })

        return { doc, credential, deps }
      }

      test(`a Disable that holds the block lock is waited for: the ${name} is refused 409 credentials-disabled and no secret is made or read`, async () => {
        const { doc, credential, deps } = await setUp()
        const held = await locker.lock(
          block.credentialsBlockLockName(doc.teamId, doc.environment)
        )

        const attempt = act(credential, deps)
        const settled = attempt.catch((error) => error)

        await new Promise((resolve) => setTimeout(resolve, 250))
        await block.blockCredentials(db, { ...doc, actor: admin })
        await held.free()

        expect(await settled).toMatchObject({
          output: { statusCode: 409 },
          data: { code: 'credentials-disabled' }
        })
        expect(deps.issuer.rotate).not.toHaveBeenCalled()
        expect(deps.vault.get).not.toHaveBeenCalled()
      })

      test(`a Disable cannot land while the ${name} is making or reading the secret: it waits for the ${name} to finish`, async () => {
        const { doc, credential, deps } = await setUp()
        let release
        const gate = new Promise((resolve) => {
          release = resolve
        })
        const secretOperation = secretCall(deps, deps.vault)

        secretOperation.mockImplementationOnce(async () => {
          await gate

          return name === 'rotate'
            ? { keyHint: 'wxyz', secret: 'new-secret' }
            : 'held-secret'
        })

        const attempt = act(credential, deps)

        await vi.waitFor(() => expect(secretOperation).toHaveBeenCalled())

        let blockedAt = null
        const disable = block.withCredentialsBlockLock(
          locker,
          doc,
          async () => {
            blockedAt = Date.now()
            await block.blockCredentials(db, { ...doc, actor: admin })
          }
        )

        await new Promise((resolve) => setTimeout(resolve, 300))

        expect(blockedAt).toBeNull()
        expect(await block.isEnvironmentBlocked(db, doc)).toBe(false)

        release()

        await expect(attempt).resolves.toBeDefined()
        await disable

        expect(blockedAt).not.toBeNull()
        expect(await block.isEnvironmentBlocked(db, doc)).toBe(true)
      })
    })

    test('a block in one environment does not stop the team’s credential in another', async () => {
      const blocked = await teamDocument({ blocked: true })
      const other = {
        teamId: blocked.teamId,
        environment: 'development'
      }
      const { id, actor } = await teamCredential(other)
      const { registry } = stubRegistry()

      await expect(
        lifecycle.rotateCredential(
          db,
          locker,
          { id, actor },
          registry,
          stubVault()
        )
      ).resolves.toMatchObject({ secret: 'new-secret' })
    })

    test('a research credential is never blocked, even where the team’s credentials are', async () => {
      const doc = await teamDocument({ blocked: true })
      const userId = `researcher-${randomUUID()}`
      const { insertedId } = await db.collection('credentials').insertOne({
        userId,
        teamId: doc.teamId,
        environment: doc.environment,
        tier: 'research',
        status: 'active',
        externalGatewaySubscriptionId: 'ext-research',
        issuerKey: 'mock',
        keyHint: 'abcd',
        createdAt: new Date().toISOString()
      })
      const { registry } = stubRegistry()

      await expect(
        lifecycle.rotateCredential(
          db,
          locker,
          { id: insertedId.toString(), actor: { userId } },
          registry,
          stubVault()
        )
      ).resolves.toMatchObject({ secret: 'new-secret' })
    })

    test('the team can still revoke its credential while the environment is blocked, and nothing clears the block', async () => {
      const doc = await teamDocument({ blocked: true })
      const { id, actor } = await teamCredential(doc)
      const { issuer, registry } = stubRegistry()

      const revoked = await lifecycle.revokeCredential(
        db,
        locker,
        { id, actor },
        registry,
        stubVault()
      )

      expect(revoked.status).toBe('revoked')
      expect(revoked.revokedReason).toBe('user-requested')
      expect(issuer.revoke).toHaveBeenCalledTimes(1)
      expect(await block.isEnvironmentBlocked(db, doc)).toBe(true)
    })
  })

  describe('revokeCredentialRecord', () => {
    test('revokes a record with the reason it is given, and writes the revoke event only when asked to', async () => {
      const doc = await teamDocument()
      const { insertedId } = await db.collection('credentials').insertOne({
        teamId: doc.teamId,
        environment: doc.environment,
        tier: 'team',
        credentialType: 'oauth',
        status: 'active',
        externalGatewaySubscriptionId: 'ext-1',
        issuerKey: 'mock'
      })
      const credential = await db
        .collection('credentials')
        .findOne({ _id: insertedId })
      const issuer = { revoke: vi.fn().mockResolvedValue(undefined) }
      const vault = { remove: vi.fn().mockResolvedValue(undefined) }

      const revoked = await lifecycle.revokeCredentialRecord(
        db,
        credential,
        {
          actor: admin,
          role: 'platform-admin',
          revokedReason: 'admin-revoked',
          audit: false
        },
        { forCredential: () => ({ issuer }) },
        vault
      )

      expect(revoked).toMatchObject({
        status: 'revoked',
        revokedReason: 'admin-revoked',
        allowedDeployments: expect.any(Array)
      })
      expect(issuer.revoke).toHaveBeenCalledWith({
        externalId: 'ext-1',
        environment: doc.environment
      })
      expect(vault.remove).toHaveBeenCalledTimes(1)
      expect(await auditEventsFor(doc.teamId)).toEqual([])
    })
  })
})
