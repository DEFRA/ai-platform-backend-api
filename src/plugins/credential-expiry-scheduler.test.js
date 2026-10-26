function fakeServer(overrides = {}) {
  return {
    db: {},
    locker: {},
    logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    events: { on: vi.fn() },
    ...overrides
  }
}

// The sweep's services, mocked: each test says what they find.
function mockServices({
  expire = { expired: 0, suspended: 0 },
  reconcile = { reconciled: 0, vaultReconciled: 0 },
  credentials = 0,
  strays = 0
} = {}) {
  vi.doMock('#/services/maintenance-service.js', () => ({
    expireCredentials: vi.fn().mockResolvedValue(expire),
    reconcilePendingCredentials: vi.fn().mockResolvedValue(reconcile),
    flagStraySubscriptions: vi.fn().mockResolvedValue(strays)
  }))
  vi.doMock('#/services/team-credential-grant.js', () => ({
    recoverTeamCredentials: vi.fn().mockResolvedValue(credentials)
  }))
}

describe('#credentialExpiryScheduler', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  function enableEveryTick() {
    vi.useFakeTimers()
    vi.stubEnv('MAINTENANCE_SCHEDULER_ENABLED', 'true')
    vi.stubEnv('MAINTENANCE_SCHEDULER_INTERVAL_MS', '1000')
  }

  test('runs an expiry sweep on each interval tick and logs a non-zero result', async () => {
    enableEveryTick()
    mockServices({
      expire: { expired: 1, suspended: 1 },
      credentials: 1,
      strays: 1
    })

    const { credentialExpiryScheduler } =
      await import('#/plugins/credential-expiry-scheduler.js')
    const {
      expireCredentials,
      reconcilePendingCredentials,
      flagStraySubscriptions
    } = await import('#/services/maintenance-service.js')
    const { recoverTeamCredentials } =
      await import('#/services/team-credential-grant.js')
    const server = fakeServer()

    credentialExpiryScheduler.plugin.register(server)

    expect(server.logger.info).toHaveBeenCalledWith(
      { intervalMs: 1000 },
      'Credential expiry scheduler started'
    )

    await vi.advanceTimersByTimeAsync(1000)

    const result = {
      expired: 1,
      suspended: 1,
      reconciled: 0,
      vaultReconciled: 0,
      credentials: 1,
      straySubscriptions: 1
    }

    expect(expireCredentials).toHaveBeenCalledWith(
      server.db,
      server.locker,
      undefined,
      server.logger
    )
    expect(reconcilePendingCredentials).toHaveBeenCalledWith(
      server.db,
      server.locker
    )
    expect(recoverTeamCredentials).toHaveBeenCalledWith(server.db, {
      locker: server.locker,
      logger: server.logger
    })
    expect(flagStraySubscriptions).toHaveBeenCalledWith(server.logger)
    expect(server.logger.debug).toHaveBeenCalledWith(
      result,
      'Credential expiry sweep ran'
    )
    expect(server.logger.info).toHaveBeenCalledWith(
      result,
      'Credential expiry sweep completed'
    )
  })

  test('does not poll team deployments: they move on events and the operations sweeper', async () => {
    enableEveryTick()
    mockServices()

    const { credentialExpiryScheduler } =
      await import('#/plugins/credential-expiry-scheduler.js')
    const server = fakeServer()

    credentialExpiryScheduler.plugin.register(server)
    await vi.advanceTimersByTimeAsync(1000)

    expect(server.logger.debug).toHaveBeenCalledWith(
      {
        expired: 0,
        suspended: 0,
        reconciled: 0,
        vaultReconciled: 0,
        credentials: 0,
        straySubscriptions: 0
      },
      'Credential expiry sweep ran'
    )
  })

  test('logs only at debug when a sweep changed nothing', async () => {
    enableEveryTick()
    mockServices()

    const { credentialExpiryScheduler } =
      await import('#/plugins/credential-expiry-scheduler.js')
    const server = fakeServer()

    credentialExpiryScheduler.plugin.register(server)
    await vi.advanceTimersByTimeAsync(1000)

    expect(server.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: 0 }),
      'Credential expiry sweep ran'
    )
    expect(server.logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Credential expiry sweep completed'
    )
  })

  test('logs at info when the only change is a team credential created for an active deployment', async () => {
    enableEveryTick()
    mockServices({ credentials: 2 })

    const { credentialExpiryScheduler } =
      await import('#/plugins/credential-expiry-scheduler.js')
    const server = fakeServer()

    credentialExpiryScheduler.plugin.register(server)
    await vi.advanceTimersByTimeAsync(1000)

    expect(server.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: 2 }),
      'Credential expiry sweep completed'
    )
  })

  test('does not schedule a sweep when disabled', async () => {
    vi.stubEnv('MAINTENANCE_SCHEDULER_ENABLED', 'false')
    mockServices()

    const { credentialExpiryScheduler } =
      await import('#/plugins/credential-expiry-scheduler.js')
    const { expireCredentials } =
      await import('#/services/maintenance-service.js')
    const server = fakeServer()

    credentialExpiryScheduler.plugin.register(server)

    expect(server.logger.info).toHaveBeenCalledWith(
      'Credential expiry scheduler disabled'
    )
    expect(server.events.on).not.toHaveBeenCalled()
    expect(expireCredentials).not.toHaveBeenCalled()
  })

  test('logs and keeps running when a sweep throws', async () => {
    enableEveryTick()
    vi.doMock('#/services/maintenance-service.js', () => ({
      expireCredentials: vi.fn().mockRejectedValue(new Error('mongo down')),
      reconcilePendingCredentials: vi.fn(),
      flagStraySubscriptions: vi.fn()
    }))
    vi.doMock('#/services/team-credential-grant.js', () => ({
      recoverTeamCredentials: vi.fn()
    }))

    const { credentialExpiryScheduler } =
      await import('#/plugins/credential-expiry-scheduler.js')
    const server = fakeServer()

    credentialExpiryScheduler.plugin.register(server)

    await vi.advanceTimersByTimeAsync(1000)

    expect(server.logger.error).toHaveBeenCalledWith(
      expect.any(Error),
      'Credential expiry sweep failed'
    )
  })

  test('clears the interval when the server stop event fires', async () => {
    enableEveryTick()
    mockServices()

    const { credentialExpiryScheduler } =
      await import('#/plugins/credential-expiry-scheduler.js')
    const { expireCredentials } =
      await import('#/services/maintenance-service.js')

    let stopHandler
    const server = fakeServer({
      events: {
        on: vi.fn((event, handler) => {
          stopHandler = handler
        })
      }
    })

    credentialExpiryScheduler.plugin.register(server)
    stopHandler()

    await vi.advanceTimersByTimeAsync(1000)

    expect(expireCredentials).not.toHaveBeenCalled()
  })
})
