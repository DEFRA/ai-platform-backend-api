import { config } from '#/config.js'
import {
  mockDirectory as defaultMockDirectory,
  createMockDirectory
} from '#/adapters/mock-directory.js'

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
 * Mutable registry holding the directory singleton. Starts with seeded people
 * only; the directoryPlugin upgrades to a database-aware version after MongoDB
 * is ready. Use `getDirectory()` to read; use `setDirectory()` to write.
 * @type {{current: import('#/adapters/directory.js').Directory}}
 */
const directoryRegistry = {
  current: selectDirectory(
    { mock: defaultMockDirectory },
    config.get('directory.mode'),
    config.get('cdpEnvironment')
  )
}

/**
 * Reads the current directory (seeded by default, database-aware after plugin init).
 * @returns {import('#/adapters/directory.js').Directory}
 */
export function getDirectory() {
  return directoryRegistry.current
}

/**
 * Called by the directoryPlugin to set the enhanced directory after MongoDB
 * is available. This allows services to use the database-aware directory
 * while keeping tests compatible (they can mock the singleton).
 * @param {import('#/adapters/directory.js').Directory} newDirectory
 */
export function setDirectory(newDirectory) {
  directoryRegistry.current = newDirectory
}

/**
 * Creates a mock directory that searches both seeded people and the database.
 * Use this in the Hapi server setup after MongoDB is available (e.g., in a
 * server decorator or plugin).
 * @param {import('mongodb').Db} db - the MongoDB database instance
 * @returns {import('#/adapters/directory.js').Directory}
 */
export function createMockDirectoryWithDb(db) {
  return createMockDirectory({ db })
}
