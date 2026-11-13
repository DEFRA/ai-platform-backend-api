import { ObjectId } from 'mongodb'

import { existingTeamId } from '#/common/helpers/team-id.js'

describe('#existingTeamId', () => {
  let server
  let db

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  async function insertTeam() {
    const slug = `id-${new ObjectId().toString().slice(-10)}`
    const { insertedId } = await db
      .collection('teams')
      .insertOne({ name: slug, normalisedName: slug, slug })

    return { id: insertedId.toString(), slug }
  }

  test('is the id when a team holds it', async () => {
    const { id } = await insertTeam()

    expect(await existingTeamId(db, id)).toBe(id)
  })

  test.each([
    ['an id no team holds', () => new ObjectId().toString()],
    ['a slug', (team) => team.slug],
    ['the id in capitals', (team) => team.id.toUpperCase()],
    ['text that is no id at all', () => 'x'.repeat(200)]
  ])('is null for %s', async (_name, valueOf) => {
    expect(await existingTeamId(db, valueOf(await insertTeam()))).toBeNull()
  })
})
