import { config } from '#/config.js'
import { mockDirectory } from '#/adapters/mock-directory.js'

/**
 * Picks the `Directory` for a directory mode, the same switch the tenant
 * orchestrator registry makes: refuses the mock in the prod environment,
 * where fictional people must never be offered. Only `mock` is registered
 * until B27's token reaches the Graph adapter (hand-off H1), which registers
 * `graph` here and removes its refusal.
 * @param {Record<string, import('#/adapters/directory.js').Directory>} directoriesByMode
 * @param {string} mode - `mock` or `graph`
 * @param {string} cdpEnvironment
 * @returns {import('#/adapters/directory.js').Directory}
 */
export function selectDirectory(directoriesByMode, mode, cdpEnvironment) {
  if (cdpEnvironment === 'prod' && mode === 'mock') {
    throw new Error('DIRECTORY_MODE must not be "mock" in the prod environment')
  }

  const selected = directoriesByMode[mode]

  if (!selected) {
    throw new Error(
      mode === 'graph'
        ? "DIRECTORY_MODE=graph needs B27's portal token"
        : `No directory for directory mode "${mode}"`
    )
  }

  return selected
}

/**
 * The directory, chosen from `DIRECTORY_MODE` at startup.
 * @type {import('#/adapters/directory.js').Directory}
 */
export const directory = selectDirectory(
  { mock: mockDirectory },
  config.get('directory.mode'),
  config.get('cdpEnvironment')
)
