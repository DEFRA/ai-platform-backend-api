describe('#credentialExpiryScheduler', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  test('runs an expiry sweep on each interval tick and logs a non-zero result', async () => {
    vi.useFakeTimers()
    vi.stubEnv('MAINTENANCE_SCHEDULER_ENABLED', 'true')
    vi.stubEnv('MAINTENANCE_SCHEDULER_INTERVAL_MS', '1000')

    vi.doMock('#/services/maintenance-service.js', () => ({
      expireCredentials: vi.fn().mockResolvedValue({ expired: 1, suspended: 1 }),
      reconcilePendingCredentials: vi
        .fn()
        .mockResolvedValue({ reconciled: 0, vaultReconciled: 0 })
    }))

    const { credentialExpiryScheduler } = await import(
      '#/plugins/credential-expiry-scheduler.js'
    )
    const { expireCredentials, reconcilePendingCredentials } = await import(
      '#/services/maintenance-service.js'
    )

    const server = {
      db: {},
      locker: {},
      logger: { info: vi.fn(), error: vi.fn() },
      events: { on: vi.fn() }
    }

    credentialExpiryScheduler.plugin.register(server)

    await vi.advanceTimersByTimeAsync(1000)

    expect(expireCredentials).toHaveBeenCalledWith(server.db, server.locker)
    expect(reconcilePendingCredentials).toHaveBeenCalledWith(server.db)
    expect(server.logger.info).toHaveBeenCalledWith(
      { expired: 1, suspended: 1, reconciled: 0, vaultReconciled: 0 },
      'Credential expiry sweep completed'
    )
  })

  test('does not schedule a sweep when disabled', async () => {
    vi.stubEnv('MAINTENANCE_SCHEDULER_ENABLED', 'false')

    vi.doMock('#/services/maintenance-service.js', () => ({
      expireCredentials: vi.fn(),
      reconcilePendingCredentials: vi.fn()
    }))

    const { credentialExpiryScheduler } = await import(
      '#/plugins/credential-expiry-scheduler.js'
    )
    const { expireCredentials } = await import(
      '#/services/maintenance-service.js'
    )

    const server = {
      db: {},
      locker: {},
      logger: { info: vi.fn(), error: vi.fn() },
      events: { on: vi.fn() }
    }

    credentialExpiryScheduler.plugin.register(server)

    expect(server.events.on).not.toHaveBeenCalled()
    expect(expireCredentials).not.toHaveBeenCalled()
  })

  test('logs and keeps running when a sweep throws', async () => {
    vi.useFakeTimers()
    vi.stubEnv('MAINTENANCE_SCHEDULER_ENABLED', 'true')
    vi.stubEnv('MAINTENANCE_SCHEDULER_INTERVAL_MS', '1000')

    vi.doMock('#/services/maintenance-service.js', () => ({
      expireCredentials: vi.fn().mockRejectedValue(new Error('mongo down')),
      reconcilePendingCredentials: vi.fn()
    }))

    const { credentialExpiryScheduler } = await import(
      '#/plugins/credential-expiry-scheduler.js'
    )

    const server = {
      db: {},
      locker: {},
      logger: { info: vi.fn(), error: vi.fn() },
      events: { on: vi.fn() }
    }

    credentialExpiryScheduler.plugin.register(server)

    await vi.advanceTimersByTimeAsync(1000)

    expect(server.logger.error).toHaveBeenCalledWith(
      expect.any(Error),
      'Credential expiry sweep failed'
    )
  })

  test('clears the interval when the server stop event fires', async () => {
    vi.useFakeTimers()
    vi.stubEnv('MAINTENANCE_SCHEDULER_ENABLED', 'true')
    vi.stubEnv('MAINTENANCE_SCHEDULER_INTERVAL_MS', '1000')

    vi.doMock('#/services/maintenance-service.js', () => ({
      expireCredentials: vi.fn().mockResolvedValue({ expired: 0, suspended: 0 }),
      reconcilePendingCredentials: vi
        .fn()
        .mockResolvedValue({ reconciled: 0, vaultReconciled: 0 })
    }))

    const { credentialExpiryScheduler } = await import(
      '#/plugins/credential-expiry-scheduler.js'
    )
    const { expireCredentials } = await import(
      '#/services/maintenance-service.js'
    )

    let stopHandler
    const server = {
      db: {},
      locker: {},
      logger: { info: vi.fn(), error: vi.fn() },
      events: { on: vi.fn((event, handler) => { stopHandler = handler }) }
    }

    credentialExpiryScheduler.plugin.register(server)
    stopHandler()

    await vi.advanceTimersByTimeAsync(1000)

    expect(expireCredentials).not.toHaveBeenCalled()
  })
})
