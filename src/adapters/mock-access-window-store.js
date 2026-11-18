import {
  accessWindowNamedValueName,
  formatAccessWindow,
  parseAccessWindow
} from '#/adapters/access-window-format.js'

function keyOf(environment, teamSlug) {
  if (typeof environment !== 'string' || environment.length === 0) {
    const error = new Error('An access window needs an environment')
    error.code = 'environment-not-configured'
    throw error
  }

  accessWindowNamedValueName(teamSlug)

  return `${environment}/${teamSlug}`
}

/**
 * Creates an in-memory `AccessWindowStore` that keeps each window as the
 * text the gateway would hold, so it applies the same format rules as the
 * APIM adapter. Writes nothing outside the process.
 * @returns {import('#/adapters/access-window-store.js').AccessWindowStore}
 */
export function createMockAccessWindowStore() {
  const values = new Map()

  return {
    async read({ environment, teamSlug }) {
      return parseAccessWindow(
        values.get(keyOf(environment, teamSlug)) ?? formatAccessWindow([])
      )
    },

    async write({ environment, teamSlug, entries }) {
      const key = keyOf(environment, teamSlug)

      values.set(key, formatAccessWindow(entries))
    }
  }
}

export const mockAccessWindowStore = createMockAccessWindowStore()
