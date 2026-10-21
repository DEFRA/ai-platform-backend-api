function fakeDb(dueCredentials) {
  const updateOne = vi.fn().mockResolvedValue({})
  const find = vi.fn().mockReturnValue({
    toArray: vi.fn().mockResolvedValue(dueCredentials)
  })

  return {
    collection: vi.fn().mockReturnValue({ find, updateOne })
  }
}

function fakeLocker() {
  return { lock: vi.fn().mockResolvedValue({ free: vi.fn() }) }
}

describe('#expireCredentials', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('#/services/audit-service.js')
  })

  test('suspends before marking expired, and keeps processing after one credential fails', async () => {
    vi.doMock('#/services/audit-service.js', () => ({
      recordAuditEvent: vi.fn().mockResolvedValue(undefined)
    }))

    const { expireCredentials } =
      await import('#/services/maintenance-service.js')

    const failing = { _id: 'cred-1', userId: 'user-1' }
    const succeeding = { _id: 'cred-2', userId: 'user-2' }
    const db = fakeDb([failing, succeeding])
    const logger = { error: vi.fn() }

    const suspend = vi
      .fn()
      .mockRejectedValueOnce(new Error('ARM request failed: PATCH ... -> 403'))
      .mockResolvedValueOnce({ externalId: 'cred-2' })
    const registry = { forCredential: () => ({ issuer: { suspend } }) }

    const { expired, suspended } = await expireCredentials(
      db,
      fakeLocker(),
      registry,
      logger
    )

    expect(suspend).toHaveBeenCalledTimes(2)
    expect(expired).toBe(1)
    expect(suspended).toBe(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('cred-1')
    )

    const { updateOne } = db.collection.mock.results[0].value
    expect(updateOne).toHaveBeenCalledTimes(1)
    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'cred-2' },
      { $set: { status: 'expired' } }
    )
  })

  test('works without a logger (e.g. legacy callers)', async () => {
    vi.doMock('#/services/audit-service.js', () => ({
      recordAuditEvent: vi.fn().mockResolvedValue(undefined)
    }))

    const { expireCredentials } =
      await import('#/services/maintenance-service.js')

    const db = fakeDb([{ _id: 'cred-1', userId: 'user-1' }])
    const suspend = vi.fn().mockRejectedValue(new Error('upstream down'))
    const registry = { forCredential: () => ({ issuer: { suspend } }) }

    await expect(
      expireCredentials(db, fakeLocker(), registry)
    ).resolves.toEqual({ expired: 0, suspended: 0 })
  })
})

describe('#pollTeamDeployments', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('#/services/team-deployment-gitops.js')
  })

  test('sweeps GitHub-mode team deployments with the scheduler lock manager and logger', async () => {
    const sweepGitopsDeployments = vi
      .fn()
      .mockResolvedValue({ polled: 2, transitioned: 1, abandoned: 0 })

    vi.doMock('#/services/team-deployment-gitops.js', () => ({
      sweepGitopsDeployments
    }))

    const { pollTeamDeployments } =
      await import('#/services/maintenance-service.js')
    const db = {}
    const locker = {}
    const logger = { error: vi.fn() }

    await expect(pollTeamDeployments(db, locker, logger)).resolves.toEqual({
      polled: 2,
      transitioned: 1,
      abandoned: 0
    })
    expect(sweepGitopsDeployments).toHaveBeenCalledWith(db, { locker, logger })
  })
})

describe('#flagStraySubscriptions', () => {
  afterEach(() => {
    vi.resetModules()
  })

  function liveRegistry(findStraySubscriptions) {
    return {
      isMockedFor: () => false,
      forCredential: vi.fn(() => ({ issuer: { findStraySubscriptions } }))
    }
  }

  test('warns about each stray subscription in the research environment and returns the count', async () => {
    const { flagStraySubscriptions } =
      await import('#/services/maintenance-service.js')
    const find = vi.fn().mockResolvedValue([
      { name: 'manual-key', reasons: ['unexpected-name'] },
      { name: 'research-u-m', reasons: ['unexpected-scope'] }
    ])
    const logger = { warn: vi.fn(), error: vi.fn() }

    await expect(
      flagStraySubscriptions(logger, liveRegistry(find))
    ).resolves.toBe(2)

    expect(find).toHaveBeenCalledWith({ environment: 'infradev' })
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(
      {
        environment: 'infradev',
        subscription: 'manual-key',
        reasons: ['unexpected-name']
      },
      expect.stringContaining('not a research key')
    )
  })

  test('does not look when research is mocked', async () => {
    const { flagStraySubscriptions } =
      await import('#/services/maintenance-service.js')
    const registry = { isMockedFor: () => true, forCredential: vi.fn() }

    await expect(flagStraySubscriptions(undefined, registry)).resolves.toBe(0)
    expect(registry.forCredential).not.toHaveBeenCalled()
  })

  test('logs and reports none when the check itself fails, without throwing', async () => {
    const { flagStraySubscriptions } =
      await import('#/services/maintenance-service.js')
    const find = vi.fn().mockRejectedValue(new Error('ARM request failed'))
    const logger = { warn: vi.fn(), error: vi.fn() }

    await expect(
      flagStraySubscriptions(logger, liveRegistry(find))
    ).resolves.toBe(0)
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('stray')
    )
  })

  test('works without a logger', async () => {
    const { flagStraySubscriptions } =
      await import('#/services/maintenance-service.js')
    const find = vi
      .fn()
      .mockResolvedValue([{ name: 'manual-key', reasons: ['unexpected-name'] }])

    await expect(
      flagStraySubscriptions(undefined, liveRegistry(find))
    ).resolves.toBe(1)
  })
})
