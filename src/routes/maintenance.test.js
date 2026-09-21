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
  })
})
