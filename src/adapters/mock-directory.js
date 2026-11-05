import { readFileSync } from 'node:fs'

/**
 * Every seeded person's `oid` starts with this, so a seeded person is never
 * mistaken for a real one and cannot clash with an Entra object ID.
 */
export const MOCK_DIRECTORY_OID_PREFIX = '5eed0000-0000-4000-8000-'

const seededPeople = JSON.parse(
  readFileSync(
    new URL('./fixtures/directory-people.json', import.meta.url),
    'utf8'
  )
)

function words(text) {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * The way Graph's `$search` on `displayName` and `mail` matches: every word of
 * the query starts a word of the name, in any order, or the mail starts with
 * the whole query (DF:50).
 * @param {import('#/adapters/directory.js').DirectoryPerson} person
 * @param {string} query
 */
function matches(person, query) {
  const queryWords = words(query)

  if (queryWords.length === 0) {
    return false
  }

  const nameWords = words(person.displayName)
  const byName = queryWords.every((queryWord) =>
    nameWords.some((nameWord) => nameWord.startsWith(queryWord))
  )

  return (
    byName ||
    (person.mail ?? '').toLowerCase().startsWith(query.trim().toLowerCase())
  )
}

/**
 * A `Directory` over fictional people, the default in every environment but
 * prod until Graph is switched on (B08's "Mocked" row). It needs no user
 * assertion.
 * @param {{people?: import('#/adapters/directory.js').DirectoryPerson[]}} [options]
 * @returns {import('#/adapters/directory.js').Directory}
 */
export function createMockDirectory({ people = seededPeople } = {}) {
  return {
    async searchPeople({ query }) {
      return structuredClone(people.filter((person) => matches(person, query)))
    },
    async getPerson({ oid }) {
      const person = people.find((candidate) => candidate.oid === oid)

      return person ? structuredClone(person) : null
    }
  }
}

export const mockDirectory = createMockDirectory()
