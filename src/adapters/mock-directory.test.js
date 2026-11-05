import { readFileSync } from 'node:fs'

import { describeDirectoryContract } from '#/adapters/directory-contract.js'
import {
  MOCK_DIRECTORY_OID_PREFIX,
  createMockDirectory,
  mockDirectory
} from '#/adapters/mock-directory.js'

const seeds = JSON.parse(
  readFileSync(
    new URL('./fixtures/directory-people.json', import.meta.url),
    'utf8'
  )
)

describeDirectoryContract('mock', ({ people }) =>
  createMockDirectory({ people })
)

describe('#mockDirectory seeds', () => {
  test('every seeded oid starts with the reserved prefix and is unique', () => {
    const oids = seeds.map((person) => person.oid)

    expect(oids.length).toBeGreaterThanOrEqual(10)
    expect(oids.every((oid) => oid.startsWith(MOCK_DIRECTORY_OID_PREFIX))).toBe(
      true
    )
    expect(new Set(oids).size).toBe(oids.length)
  })

  test('holds eligible people, a supplier, a guest and a look-alike domain', async () => {
    const everyone = await Promise.all(
      ['supplier', 'guest', 'lookalike', 'hartley'].map((query) =>
        mockDirectory.searchPeople({ query })
      )
    )

    expect(everyone.map((found) => found.length)).toEqual([1, 1, 1, 1])
    expect(everyone[1][0].userPrincipalName).toContain('#EXT#')
    expect(everyone[2][0].userPrincipalName).toContain(
      'defra.gov.uk.example.com'
    )
  })
})

describe('#mockDirectory matching', () => {
  test('finds the journey person by name, in any word order and case', async () => {
    for (const query of ['journey', 'Journey Test', 'member journey']) {
      const found = await mockDirectory.searchPeople({ query })

      expect(found.map((person) => person.displayName)).toEqual([
        'Journey Test Member'
      ])
    }
  })

  test('finds the journey person by the start of the email', async () => {
    const found = await mockDirectory.searchPeople({
      query: 'journey.test.me'
    })

    expect(found.map((person) => person.mail)).toEqual([
      'journey.test.member@defra.gov.uk'
    ])
  })

  test('matches the start of a name word, not the middle of one', async () => {
    await expect(
      mockDirectory.searchPeople({ query: 'ourney' })
    ).resolves.toEqual([])
    await expect(
      mockDirectory.searchPeople({ query: 'melia' })
    ).resolves.toEqual([])
  })

  test('does not match the middle of an email', async () => {
    await expect(
      mockDirectory.searchPeople({ query: 'test.member@defra' })
    ).resolves.toEqual([])
  })

  test('a person with no mail is found by name only', async () => {
    const found = await mockDirectory.searchPeople({ query: 'farid' })

    expect(found).toHaveLength(1)
    expect(found[0].mail).toBeNull()
  })

  test('returns no one for a blank query', async () => {
    await expect(mockDirectory.searchPeople({ query: '   ' })).resolves.toEqual(
      []
    )
  })

  test('needs no user assertion', async () => {
    await expect(
      mockDirectory.getPerson({ oid: seeds[0].oid })
    ).resolves.toEqual(seeds[0])
  })

  test('returns copies, so a caller cannot change the seeds', async () => {
    const [first] = await mockDirectory.searchPeople({ query: 'journey' })

    first.displayName = 'Changed'

    const [second] = await mockDirectory.searchPeople({ query: 'journey' })

    expect(second.displayName).toBe('Journey Test Member')
  })
})
