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
