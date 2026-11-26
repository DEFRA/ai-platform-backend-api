import { usageNotAvailable } from '#/adapters/usage-reader.js'

const MS_PER_DAY = 86_400_000
const DAY_LENGTH = 10
const MOCK_MODELS = ['gpt-4o', 'gpt-4-1-nano']
const SEED_MULTIPLIER = 31
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]*$/

// The same slug always gives the same figures, so a local run is repeatable.
function seedOf(text) {
  return [...text].reduce(
    (seed, char) => (seed * SEED_MULTIPLIER + char.codePointAt(0)) % 9973,
    7
  )
}

function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)

  return Array.from(
    { length: Math.max(0, (end - start) / MS_PER_DAY) },
    (_, index) =>
      new Date(start + index * MS_PER_DAY).toISOString().slice(0, DAY_LENGTH)
  )
}

/**
 * Invented, repeatable usage for a local run with no Azure behind it. It
 * knows only the team it is asked about; asked for every API it has nothing,
 * so no fictional team ever appears beside a real one.
 * @returns {import('#/adapters/usage-reader.js').UsageReader}
 */
export function createMockUsageReader() {
  return {
    source: 'mock',

    async readUsage({ environment, from, to, teamSlug }) {
      if (!ENVIRONMENT_NAME.test(environment)) {
        throw usageNotAvailable(`No usage for "${environment}"`)
      }

      if (teamSlug === undefined) {
        return []
      }

      return daysBetween(from, to).flatMap((day) =>
        MOCK_MODELS.map((model) => {
          const seed = seedOf(`${teamSlug}${day}${model}`)

          return {
            day,
            teamSlug,
            deployment: `${teamSlug}-${model}`,
            requests: 5 + (seed % 40),
            promptTokens: 2000 + seed * 3,
            completionTokens: 500 + seed
          }
        })
      )
    }
  }
}

export const mockUsageReader = createMockUsageReader()
