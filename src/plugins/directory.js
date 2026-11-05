import { config } from '#/config.js'
import {
  createMockDirectoryWithDb,
  setDirectory
} from '#/adapters/directory-registry.js'

/**
 * Hapi plugin that enhances the mock directory with database lookups after
 * MongoDB is available. When the directory mode is `mock`, creates a
 * directory that searches both seeded people and users in MongoDB, updating
 * the exported directory in directory-registry so services use it.
 */
export const directoryPlugin = {
  name: 'directory',
  version: '1.0.0',
  dependencies: ['mongodb'],
  register: async function (server) {
    const directoryMode = config.get('directory.mode')

    if (directoryMode === 'mock') {
      server.logger.info('Enhancing mock directory with database lookups')

      try {
        // Create a directory that searches both seeded people and MongoDB users
        const enhancedDirectory = createMockDirectoryWithDb(server.db)

        // Update the exported directory in directory-registry so services use it
        setDirectory(enhancedDirectory)

        // Also decorate the server for direct access if needed
        server.decorate('server', 'directory', enhancedDirectory)
      } catch (error) {
        server.logger.error(
          error,
          'Failed to enhance mock directory, using default'
        )
      }
    }
  }
}
