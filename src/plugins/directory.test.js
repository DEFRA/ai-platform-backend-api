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

  test('enhanced directory searches seeded people', async () => {
    const found = await server.directory.searchPeople({ query: 'journey' })

    expect(found).toHaveLength(1)
    expect(found[0].displayName).toBe('Journey Test Member')
  })

  test('directory finds newly created Mongo user by displayName', async () => {
    const oid = randomUUID()
    const email = `directory-${oid}@defra.gov.uk`
    await server.db.collection('users').insertOne({
      oid,
      tid: '6f504113-6b64-43f2-ade9-242e05780007',
      email,
      userPrincipalName: email,
      displayName: 'Mongo Directory Member'
    })

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
  })

  test('directory finds newly created Mongo user with word order reversed', async () => {
    const oid = randomUUID()
    const email = `directory-reverse-${oid}@defra.gov.uk`
    await server.db.collection('users').insertOne({
      oid,
      tid: '6f504113-6b64-43f2-ade9-242e05780007',
      email,
      userPrincipalName: email,
      displayName: 'Ada Lovelace'
    })

    // Search by reversed word order should still find the user
    const found = await server.directory.searchPeople({
      query: 'lovelace ada'
    })

    expect(found).toEqual([
      expect.objectContaining({
        oid,
        displayName: 'Ada Lovelace',
        mail: email,
        userPrincipalName: email
      })
    ])
  })
})
