import { randomUUID } from 'node:crypto'

import { ObjectId } from 'mongodb'

describe('#maintenance routes', () => {
  let server

  beforeAll(async () => {
    process.env.MAINTENANCE_TOKEN = 'test-maintenance-token'

    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  test('POST /maintenance/expire-credentials rejects a missing token', async () => {
    const { statusCode } = await server.inject({
      method: 'POST',
      url: '/maintenance/expire-credentials',
      headers: { 'x-maintenance-token': 'wrong-token' }
    })

    expect(statusCode).toBe(401)
  })

  test('POST /maintenance/expire-credentials expires past-due credentials', async () => {
    const headers = {
      'x-user-id': 'maintenance-user',
      'idempotency-key': randomUUID()
    }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })

    await server.db
      .collection('credentials')
      .updateOne(
        { _id: new ObjectId(issued.result.credential._id) },
        { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } }
      )

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/maintenance/expire-credentials',
      headers: { 'x-maintenance-token': 'test-maintenance-token' }
    })

    expect(statusCode).toBe(200)
    expect(result.expired).toBeGreaterThanOrEqual(1)
    expect(result.suspended).toBeGreaterThanOrEqual(1)
    expect(result).toHaveProperty('reconciled')
    expect(result).toHaveProperty('vaultReconciled')
    expect(result.straySubscriptions).toBe(0)
  })

  test('POST /maintenance/expire-credentials retries a credential flagged vaultState: unwritten', async () => {
    const headers = {
      'x-user-id': 'maintenance-vault-user',
      'idempotency-key': randomUUID()
    }
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: { modelSlug: 'gpt-4o' }
    })
    const id = new ObjectId(issued.result.credential._id)

    await server.db
      .collection('credentials')
      .updateOne({ _id: id }, { $set: { vaultState: 'unwritten' } })

    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/maintenance/expire-credentials',
      headers: { 'x-maintenance-token': 'test-maintenance-token' }
    })

    expect(statusCode).toBe(200)
    expect(result.vaultReconciled).toBeGreaterThanOrEqual(1)

    const credential = await server.db
      .collection('credentials')
      .findOne({ _id: id })

    expect(credential.vaultState).toBeUndefined()
  })

  test('POST /maintenance/expire-credentials leaves a flagged credential alone while its issuance holds the credential lock, then repairs it', async () => {
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: {
        'x-user-id': 'maintenance-inflight-user',
        'idempotency-key': randomUUID()
      },
      payload: { modelSlug: 'gpt-4o' }
    })
    const id = new ObjectId(issued.result.credential._id)

    await server.db
      .collection('credentials')
      .updateOne({ _id: id }, { $set: { vaultState: 'unwritten' } })

    // An issuance still running holds the lock revoking and reissuing use.
    const lock = await server.locker.lock(`credential:${id}`)
    const sweep = () =>
      server.inject({
        method: 'POST',
        url: '/maintenance/expire-credentials',
        headers: { 'x-maintenance-token': 'test-maintenance-token' }
      })

    await sweep()

    expect(
      (await server.db.collection('credentials').findOne({ _id: id }))
        .vaultState
    ).toBe('unwritten')

    await lock.free()
    await sweep()

    expect(
      (await server.db.collection('credentials').findOne({ _id: id }))
        .vaultState
    ).toBeUndefined()
  })

  test('POST /maintenance/expire-credentials does not reissue a credential whose marker was cleared after it was found', async () => {
    const issued = await server.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers: {
        'x-user-id': 'maintenance-cleared-user',
        'idempotency-key': randomUUID()
      },
      payload: { modelSlug: 'gpt-4o' }
    })
    const id = new ObjectId(issued.result.credential._id)

    await server.db
      .collection('credentials')
      .updateOne({ _id: id }, { $set: { vaultState: 'unwritten' } })

    // The issuance finishes (clearing the marker) just as the sweep takes the
    // lock it was waiting on: the credential is read again and left alone.
    const realLock = server.locker.lock.bind(server.locker)
    const spy = vi
      .spyOn(server.locker, 'lock')
      .mockImplementation(async (resource) => {
        if (resource === `credential:${id}`) {
          await server.db
            .collection('credentials')
            .updateOne({ _id: id }, { $unset: { vaultState: '' } })
        }

        return realLock(resource)
      })

    try {
      const { result } = await server.inject({
        method: 'POST',
        url: '/maintenance/expire-credentials',
        headers: { 'x-maintenance-token': 'test-maintenance-token' }
      })

      expect(result.vaultReconciled).not.toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
    }
  })
})
