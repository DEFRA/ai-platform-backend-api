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

  test('enhanced directory can search both seeded and database users', async () => {
    const found = await server.directory.searchPeople({ query: 'journey' })

    expect(found).toHaveLength(1)
    expect(found[0].displayName).toBe('Journey Test Member')
  })
})
