import { randomUUID } from 'node:crypto'

import { describe, test, expect, beforeAll, afterAll } from 'vitest'

describe('#directoryPlugin', () => {
  let server

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  test('decorates server.directory when directory mode is mock', () => {
    expect(server.directory).toBeDefined()
    expect(typeof server.directory.searchPeople).toBe('function')
    expect(typeof server.directory.getPerson).toBe('function')
  })

  test('enhanced directory can search and add users created through sign-in', async () => {
    const seeded = await server.directory.searchPeople({ query: 'journey' })

    expect(seeded).toHaveLength(1)
    expect(seeded[0].displayName).toBe('Journey Test Member')

    const oid = randomUUID()
    const email = `directory-${oid}@defra.gov.uk`
    const signedIn = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid,
        tid: '6f504113-6b64-43f2-ade9-242e05780007',
        email,
        displayName: 'Mongo Directory Member'
      }
    })

    expect(signedIn.statusCode).toBe(200)

    const found = await server.directory.searchPeople({
      query: 'Mongo Directory'
    })
    expect(found).toEqual([
      expect.objectContaining({
        oid,
        displayName: 'Mongo Directory Member',
        mail: email,
        userPrincipalName: email
      })
    ])
    await expect(server.directory.getPerson({ oid })).resolves.toEqual(found[0])

    const admin = await server.inject({
      method: 'POST',
      url: '/v1/users',
      payload: {
        oid: randomUUID(),
        tid: '6f504113-6b64-43f2-ade9-242e05780007',
        email: `directory-admin-${randomUUID()}@defra.gov.uk`,
        displayName: 'Directory Team Admin'
      }
    })
    const team = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: {
        'x-user-id': admin.result.user._id.toString(),
        'idempotency-key': randomUUID()
      },
      payload: {
        name: `Directory Test Team ${randomUUID()}`,
        serviceCode: 'ABC'
      }
    })
    const added = await server.inject({
      method: 'POST',
      url: `/v1/teams/${team.result.team._id}/members`,
      headers: {
        'x-user-id': admin.result.user._id.toString(),
        'idempotency-key': randomUUID()
      },
      payload: { oid, role: 'user' }
    })

    expect(added.statusCode).toBe(201)
    expect(added.result.member).toMatchObject({
      userId: signedIn.result.user._id.toString(),
      displayName: 'Mongo Directory Member',
      email,
      role: 'user',
      status: 'active'
    })
  })
})
