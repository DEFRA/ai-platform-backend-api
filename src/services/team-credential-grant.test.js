import { randomUUID } from 'node:crypto'

describe('team-credential-grant', () => {
  let server
  let db
  let grantTeamCredential
  let recoverTeamCredentials
  let retryTeamCredential
  let createCredentialGranter

  beforeAll(async () => {
    // Dynamic imports needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
    ;({
      grantTeamCredential,
      recoverTeamCredentials,
      retryTeamCredential,
      createCredentialGranter
    } = await import('#/services/team-credential-grant.js'))
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  // Older than the retry interval; and now.
  const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const justNow = () => new Date().toISOString()

  // An entry as the deployment flow stores it, in a team document of its own.
  function deploymentEntry(fields = {}) {
    return {
      id: randomUUID(),
      modelSlug: 'gpt-4o',
      status: 'active',
      operationId: randomUUID(),
      requestedBy: 'requester-1',
      ...fields
    }
  }

  async function insertDocument(...deployments) {
    const doc = {
      teamId: `credential-team-${randomUUID()}`,
      environment: 'sandbox',
      deployments
    }
    const { insertedId } = await db.collection('teamDeployments').insertOne(doc)

    return { ...doc, _id: insertedId }
  }

  async function auditEvents(entry) {
    return db
      .collection('auditEvents')
      .find({ resourceId: entry.id })
      .sort({ at: 1 })
      .toArray()
  }

  function insertCredential(doc, fields) {
    return db.collection('credentials').insertOne({
      teamId: doc.teamId,
      environment: 'sandbox',
      tier: 'team',
      credentialType: 'oauth',
      ...fields
    })
  }

  function credentialsOf(doc, filter = {}) {
    return db
      .collection('credentials')
      .find({ teamId: doc.teamId, ...filter })
      .toArray()
  }

  function settingsWith(fields = {}) {
    return {
      ensureCredential: vi.fn().mockResolvedValue({ created: true }),
      locker: server.locker,
      logger: { warn: vi.fn(), debug: vi.fn() },
      retryAfterMs: 0,
      ...fields
    }
  }

  // The parameters of the calls made for one team: others in the shared
  // database are neither failed nor created for.
  function callsFor(ensureCredential, doc) {
    return ensureCredential.mock.calls
      .map(([, , params]) => params)
      .filter(({ teamId }) => teamId === doc.teamId)
  }

  describe('the team credential on activation', () => {
    function activating(overrides = {}) {
      return deploymentEntry({ activatedAt: justNow(), ...overrides })
    }

    test('grants the model to the team credential for its environment when the deployment turns active', async () => {
      const entry = activating()
      const doc = await insertDocument(entry)
      const settings = settingsWith()

      const created = await grantTeamCredential(db, doc, entry, settings)

      expect(created).toBe(true)
      expect(settings.ensureCredential).toHaveBeenCalledTimes(1)
      expect(settings.ensureCredential).toHaveBeenCalledWith(
        db,
        server.locker,
        {
          teamId: doc.teamId,
          environment: 'sandbox',
          modelSlug: 'gpt-4o',
          requestedBy: 'requester-1',
          operationId: entry.operationId,
          activatedAt: entry.activatedAt
        }
      )
    })

    test('passes no activation time for an entry without one', async () => {
      const entry = activating({ activatedAt: undefined })
      const doc = await insertDocument(entry)
      const settings = settingsWith()

      await grantTeamCredential(db, doc, entry, settings)

      expect(settings.ensureCredential).toHaveBeenCalledWith(
        db,
        server.locker,
        expect.objectContaining({ activatedAt: null })
      )
    })

    test('creates the credential for real, once, however often it is called', async () => {
      const entry = activating()
      const doc = await insertDocument(entry)
      const settings = { locker: server.locker }

      expect(await grantTeamCredential(db, doc, entry, settings)).toBe(true)
      expect(await grantTeamCredential(db, doc, entry, settings)).toBe(false)
      expect(
        await grantTeamCredential(db, doc, entry, settings, { retry: true })
      ).toBe(false)

      const credentials = await credentialsOf(doc)

      expect(credentials).toHaveLength(1)
      expect(credentials[0]).toMatchObject({
        tier: 'team',
        environment: 'sandbox',
        status: 'active',
        userId: 'requester-1'
      })
    })

    test('reports no credential created when none was', async () => {
      const entry = activating()
      const doc = await insertDocument(entry)
      const settings = settingsWith({
        ensureCredential: vi.fn().mockResolvedValue({ created: false })
      })

      expect(await grantTeamCredential(db, doc, entry, settings)).toBe(false)
    })

    test('logs and audits a failed credential against the operation without failing or undoing the activation', async () => {
      const failure = Object.assign(new Error('not enabled'), {
        data: { code: 'gateway-not-enabled' }
      })
      const entry = activating()
      const doc = await insertDocument(entry)
      const settings = settingsWith({
        ensureCredential: vi.fn().mockRejectedValue(failure)
      })

      expect(await grantTeamCredential(db, doc, entry, settings)).toBe(false)

      const stored = await db
        .collection('teamDeployments')
        .findOne({ _id: doc._id })

      expect(stored.deployments[0].status).toBe('active')
      expect(settings.logger.warn).toHaveBeenCalledWith(
        { code: 'gateway-not-enabled', operationId: entry.operationId },
        'Creating the team credential failed, retrying on a later poll'
      )
      expect(await auditEvents(entry)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'teamDeployment.credential',
            outcome: 'failure',
            code: 'gateway-not-enabled'
          })
        ])
      )
    })

    test('audits a failure under the error code, or a stable one when it has none', async () => {
      const coded = Object.assign(new Error('coded'), { code: 'EAI_AGAIN' })

      for (const [failure, code] of [
        [coded, 'EAI_AGAIN'],
        [new Error('plain'), 'credential-failed']
      ]) {
        const entry = activating()
        const doc = await insertDocument(entry)

        await grantTeamCredential(
          db,
          doc,
          entry,
          settingsWith({ ensureCredential: vi.fn().mockRejectedValue(failure) })
        )

        expect((await auditEvents(entry))[0]).toMatchObject({
          action: 'teamDeployment.credential',
          code
        })
      }
    })

    test('copes with no logger', async () => {
      const entry = activating()
      const doc = await insertDocument(entry)
      const settings = settingsWith({
        ensureCredential: vi.fn().mockRejectedValue(new Error('boom')),
        logger: undefined
      })

      expect(await grantTeamCredential(db, doc, entry, settings)).toBe(false)
      expect(await auditEvents(entry)).toHaveLength(1)
    })

    test('logs and audits a secret that could not be written to the vault, keeping the activation', async () => {
      const entry = activating()
      const doc = await insertDocument(entry)
      const settings = settingsWith({
        ensureCredential: vi
          .fn()
          .mockResolvedValue({ created: true, vaultWritten: false })
      })

      expect(await grantTeamCredential(db, doc, entry, settings)).toBe(true)
      expect(settings.logger.warn).toHaveBeenCalledWith(
        { code: 'vault-write-failed', operationId: entry.operationId },
        'The team secret could not be written to the vault, reconciliation will retry it'
      )
      expect(await auditEvents(entry)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'teamDeployment.credential',
            outcome: 'failure',
            code: 'vault-write-failed'
          })
        ])
      )
    })

    test('reports a secret not written to the vault even on a retry', async () => {
      const entry = activating()
      const doc = await insertDocument(entry)
      const settings = settingsWith({
        ensureCredential: vi
          .fn()
          .mockResolvedValue({ created: true, vaultWritten: false })
      })

      await grantTeamCredential(db, doc, entry, settings, { retry: true })

      expect(settings.logger.warn).toHaveBeenCalledTimes(1)
      expect(await auditEvents(entry)).toHaveLength(1)
    })

    test('keeps the activation when the failure itself cannot be audited', async () => {
      const entry = activating()
      const doc = await insertDocument(entry)
      const settings = settingsWith({
        ensureCredential: vi.fn().mockRejectedValue(new Error('boom'))
      })
      const collection = db.collection.bind(db)
      const spy = vi.spyOn(db, 'collection').mockImplementation((name) => {
        const real = collection(name)

        return name === 'auditEvents'
          ? {
              insertOne: async (event) => {
                if (event.action === 'teamDeployment.credential') {
                  throw new Error('audit down')
                }

                return real.insertOne(event)
              }
            }
          : real
      })

      try {
        expect(await grantTeamCredential(db, doc, entry, settings)).toBe(false)
      } finally {
        spy.mockRestore()
      }

      expect(settings.logger.warn).toHaveBeenCalledWith(
        { code: 'credential-failed', operationId: entry.operationId },
        'The team credential failure could not be audited'
      )
    })

    test('retries a credential still missing, logging only at debug and auditing nothing', async () => {
      const entry = activating()
      const doc = await insertDocument(entry)
      const settings = settingsWith({
        ensureCredential: vi.fn().mockRejectedValue(new Error('down'))
      })

      // Nothing recorded for the team: the credential was never created.
      expect(await retryTeamCredential(db, doc, settings, entry)).toBe(false)

      expect(settings.ensureCredential).toHaveBeenCalledTimes(1)
      expect(settings.ensureCredential).toHaveBeenCalledWith(
        db,
        server.locker,
        expect.objectContaining({ retryAfterMs: 0 })
      )
      expect(settings.logger.warn).not.toHaveBeenCalled()
      expect(settings.logger.debug).toHaveBeenCalledWith(
        { code: 'credential-failed', operationId: entry.operationId },
        'Creating the team credential failed, retrying on a later poll'
      )
      expect(await auditEvents(entry)).toEqual([])
    })

    test('retries for the entry given when the document does not yet show it as active', async () => {
      const entry = activating()
      const doc = await insertDocument({ ...entry, status: 'verified' })
      const settings = settingsWith()

      expect(await retryTeamCredential(db, doc, settings, entry)).toBe(true)
      expect(callsFor(settings.ensureCredential, doc)).toEqual([
        expect.objectContaining({
          operationId: entry.operationId,
          activatedAt: entry.activatedAt
        })
      ])
    })

    test.each([
      ['an active credential', { status: 'active' }],
      [
        'a revoked credential, which a retry never recreates',
        { status: 'revoked' }
      ]
    ])('does not retry when the team already has %s', async (_label, held) => {
      const entry = activating({ activatedAt: undefined })
      const doc = await insertDocument(entry)
      const settings = settingsWith()

      await insertCredential(doc, { createdAt: anHourAgo(), ...held })

      expect(await retryTeamCredential(db, doc, settings, entry)).toBe(false)
      expect(settings.ensureCredential).not.toHaveBeenCalled()
    })

    test('waits out the retry interval before retrying an attempt that did not finish', async () => {
      const entry = activating()
      const doc = await insertDocument(entry)
      const settings = settingsWith({ retryAfterMs: 60000 })

      const { insertedId } = await insertCredential(doc, {
        status: 'failed',
        createdAt: justNow()
      })

      await retryTeamCredential(db, doc, settings, entry)

      expect(settings.ensureCredential).not.toHaveBeenCalled()

      await db
        .collection('credentials')
        .updateOne({ _id: insertedId }, { $set: { createdAt: anHourAgo() } })
      await retryTeamCredential(db, doc, settings, entry)

      expect(settings.ensureCredential).toHaveBeenCalledTimes(1)
      expect(settings.ensureCredential).toHaveBeenCalledWith(
        db,
        server.locker,
        expect.objectContaining({ retryAfterMs: 60000 })
      )
    })
  })

  describe('recovering team credentials on the maintenance sweep', () => {
    function activeEntry(fields = {}) {
      return deploymentEntry(fields)
    }

    test('creates a credential that failed when the model turned active on a later sweep', async () => {
      const entry = activeEntry()
      const doc = await insertDocument(entry)
      let failedOnce = false
      // Other teams in the shared database are neither failed nor created for.
      const ensureCredential = vi.fn(async (_db, _locker, { teamId }) => {
        if (teamId !== doc.teamId) {
          return { created: false }
        }

        if (!failedOnce) {
          failedOnce = true
          throw new Error('issuer unavailable')
        }

        return { created: true }
      })
      const deps = settingsWith({ ensureCredential })

      expect(await recoverTeamCredentials(db, deps)).toBe(0)
      expect(await recoverTeamCredentials(db, deps)).toBe(1)

      const ours = callsFor(ensureCredential, doc)

      expect(ours).toHaveLength(2)
      expect(ours[1]).toMatchObject({
        modelSlug: 'gpt-4o',
        operationId: entry.operationId,
        retryAfterMs: 0
      })
    })

    test('creates the credential for real once, and leaves a team with one alone', async () => {
      const doc = await insertDocument(activeEntry())
      const deps = { locker: server.locker, retryAfterMs: 0 }

      expect(await recoverTeamCredentials(db, deps)).toBeGreaterThan(0)

      const held = await credentialsOf(doc)

      expect(held).toHaveLength(1)
      expect(held[0]).toMatchObject({ status: 'active', userId: 'requester-1' })

      await recoverTeamCredentials(db, deps)

      expect(await credentialsOf(doc)).toHaveLength(1)
    })

    test('waits 30 seconds between attempts at a credential by default', async () => {
      const doc = await insertDocument(activeEntry())
      const ensureCredential = vi.fn(async () => ({ created: false }))

      await insertCredential(doc, { status: 'failed', createdAt: justNow() })
      await recoverTeamCredentials(db, {
        locker: server.locker,
        ensureCredential
      })

      expect(callsFor(ensureCredential, doc)).toEqual([])

      await db
        .collection('credentials')
        .updateOne({ teamId: doc.teamId }, { $set: { createdAt: anHourAgo() } })
      await recoverTeamCredentials(db, {
        locker: server.locker,
        ensureCredential
      })

      expect(callsFor(ensureCredential, doc)).toEqual([
        expect.objectContaining({ retryAfterMs: 30000 })
      ])
    })

    test('creates the credential a newer activation is owed after an older one was revoked', async () => {
      const doc = await insertDocument(activeEntry({ activatedAt: justNow() }))

      await insertCredential(doc, {
        status: 'revoked',
        createdAt: anHourAgo(),
        revokedAt: anHourAgo()
      })
      await recoverTeamCredentials(db, {
        locker: server.locker,
        retryAfterMs: 0
      })

      expect(await credentialsOf(doc, { status: 'active' })).toHaveLength(1)
    })

    test('makes the credential for the team’s newest active deployment', async () => {
      const older = activeEntry({
        requestedBy: 'requester-old',
        modelSlug: 'gpt-4o',
        activatedAt: anHourAgo()
      })
      const newer = activeEntry({
        requestedBy: 'requester-new',
        modelSlug: 'gpt-5-mini',
        activatedAt: justNow()
      })
      const doc = await insertDocument(newer, older)
      const ensureCredential = vi.fn(async () => ({ created: false }))

      await recoverTeamCredentials(db, {
        locker: server.locker,
        ensureCredential,
        retryAfterMs: 0
      })

      expect(callsFor(ensureCredential, doc)).toEqual([
        expect.objectContaining({
          requestedBy: 'requester-new',
          modelSlug: 'gpt-5-mini',
          activatedAt: newer.activatedAt
        })
      ])
    })

    test('treats a deployment with no activation time as older than any that has one', async () => {
      const dated = activeEntry({
        modelSlug: 'gpt-5-mini',
        activatedAt: anHourAgo()
      })
      const undated = activeEntry({ modelSlug: 'gpt-4o' })

      for (const deployments of [
        [dated, undated],
        [undated, dated]
      ]) {
        const doc = await insertDocument(...deployments)
        const ensureCredential = vi.fn(async () => ({ created: false }))

        await recoverTeamCredentials(db, {
          locker: server.locker,
          ensureCredential,
          retryAfterMs: 0
        })

        expect(callsFor(ensureCredential, doc)).toEqual([
          expect.objectContaining({ modelSlug: 'gpt-5-mini' })
        ])
      }
    })

    test('does not recreate a credential an admin revoked, nor touch a team with nothing active', async () => {
      const ensureCredential = vi.fn().mockResolvedValue({ created: true })
      const revoked = await insertDocument(activeEntry())
      const notActive = await insertDocument(
        deploymentEntry({ status: 'deploying' })
      )

      await insertCredential(revoked, {
        status: 'revoked',
        createdAt: anHourAgo()
      })
      await recoverTeamCredentials(db, {
        locker: server.locker,
        ensureCredential,
        retryAfterMs: 0
      })

      const teams = ensureCredential.mock.calls.map(
        ([, , { teamId }]) => teamId
      )

      expect(teams).not.toContain(revoked.teamId)
      expect(teams).not.toContain(notActive.teamId)
    })
  })

  describe('the credential granter of the operations runtime', () => {
    function operationOf(doc, entries, fields = {}) {
      return {
        _id: randomUUID(),
        teamId: doc.teamId,
        environment: 'sandbox',
        items: entries.map(({ id, modelSlug }) => ({
          entryId: id,
          modelSlug,
          change: 'add'
        })),
        ...fields
      }
    }

    test('grants the first model the operation made active, once for the whole operation', async () => {
      const first = deploymentEntry({ activatedAt: justNow() })
      const second = deploymentEntry({
        modelSlug: 'gpt-5-mini',
        activatedAt: justNow()
      })
      const doc = await insertDocument(first, second)
      const settings = settingsWith()
      const grant = createCredentialGranter({ db, ...settings })

      await grant(operationOf(doc, [first, second]))

      expect(callsFor(settings.ensureCredential, doc)).toEqual([
        expect.objectContaining({ modelSlug: 'gpt-4o' })
      ])
    })

    test('grants nothing for an operation that only removes models', async () => {
      const entry = deploymentEntry({ activatedAt: justNow() })
      const doc = await insertDocument(entry)
      const settings = settingsWith()
      const grant = createCredentialGranter({ db, ...settings })
      const operation = operationOf(doc, [entry])

      operation.items[0].change = 'remove'
      await grant(operation)

      expect(settings.ensureCredential).not.toHaveBeenCalled()
    })

    test('grants nothing when the team document or the entries are gone', async () => {
      const entry = deploymentEntry()
      const doc = await insertDocument(entry)
      const settings = settingsWith()
      const grant = createCredentialGranter({ db, ...settings })

      await grant(operationOf({ teamId: 'no-such-team' }, [entry]))
      await grant(operationOf(doc, [deploymentEntry()]))

      expect(settings.ensureCredential).not.toHaveBeenCalled()
    })

    test('never throws: a credential failure is audited by the grant, not raised', async () => {
      const entry = deploymentEntry({ activatedAt: justNow() })
      const doc = await insertDocument(entry)
      const settings = settingsWith({
        ensureCredential: vi.fn().mockRejectedValue(new Error('vault down'))
      })
      const grant = createCredentialGranter({ db, ...settings })

      await expect(grant(operationOf(doc, [entry]))).resolves.toBeUndefined()
      expect((await auditEvents(entry))[0]).toMatchObject({
        action: 'teamDeployment.credential',
        outcome: 'failure'
      })
    })
  })
})
