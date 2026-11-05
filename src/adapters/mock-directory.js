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

/**
 * Convert a user document from MongoDB into a DirectoryPerson shape.
 * @param {import('mongodb').Document} userDoc
 * @returns {import('#/adapters/directory.js').DirectoryPerson}
 */
function userDocToDirectoryPerson(userDoc) {
  return {
    oid: userDoc.oid,
    displayName: userDoc.displayName,
    mail: userDoc.mail ?? userDoc.email ?? null,
    userPrincipalName: userDoc.userPrincipalName ?? userDoc.email
  }
}

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
 * A `Directory` over fictional people (seeded) plus real people from MongoDB,
 * the default in every environment but prod until Graph is switched on (B08's
 * "Mocked" row). It needs no user assertion. If a `db` is passed, it will
 * search and fetch users from the database in addition to seeded people.
 * @param {{people?: import('#/adapters/directory.js').DirectoryPerson[], db?: import('mongodb').Db}} [options]
 * @returns {import('#/adapters/directory.js').Directory}
 */
export function createMockDirectory({ people = seededPeople, db } = {}) {
  return {
    async searchPeople({ query }) {
      const results = structuredClone(
        people.filter((person) => matches(person, query))
      )

      if (db) {
        const users = await db
          .collection('users')
          .find({
            $or: [
              { displayName: { $regex: query, $options: 'i' } },
              { mail: { $regex: `^${query}`, $options: 'i' } },
              { userPrincipalName: { $regex: query, $options: 'i' } },
              { email: { $regex: `^${query}`, $options: 'i' } }
            ]
          })
          .toArray()

        const dbPeople = users.map(userDocToDirectoryPerson)
        const filtered = dbPeople.filter((person) => matches(person, query))

        // Avoid duplicates: if a person's oid already exists in results, skip it
        const existingOids = new Set(results.map((p) => p.oid))

        for (const person of filtered) {
          if (!existingOids.has(person.oid)) {
            results.push(person)
            existingOids.add(person.oid)
          }
        }
      }

      return results
    },
    async getPerson({ oid }) {
      const person = people.find((candidate) => candidate.oid === oid)

      if (person) {
        return structuredClone(person)
      }

      if (db) {
        const user = await db.collection('users').findOne({ oid })

        if (user) {
          return userDocToDirectoryPerson(user)
        }
      }

      return null
    }
  }
}

export const mockDirectory = createMockDirectory()
