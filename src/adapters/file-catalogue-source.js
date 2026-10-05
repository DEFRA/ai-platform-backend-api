import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultModelsPath = path.join(dirname, '../common/seed/models.seed.json')
const defaultProvidersPath = path.join(
  dirname,
  '../common/seed/providers.seed.json'
)

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

/**
 * Local-development/test `CatalogueSource` - reads the catalogue fixtures
 * committed in `src/common/seed/` instead of calling GitHub, so `npm test`
 * and compose need no network. This is the default (`CATALOGUE_SOURCE=file`)
 * everywhere except when deliberately pointed at the real catalogue repo.
 * @param {{modelsPath?: string, providersPath?: string}} [options]
 * @returns {import('./catalogue-source.js').CatalogueSource}
 */
export function createFileCatalogueSource({
  modelsPath = defaultModelsPath,
  providersPath = defaultProvidersPath
} = {}) {
  return {
    async fetchCatalogue() {
      const models = readJson(modelsPath)
      const providers = readJson(providersPath)
      const catalogueSha = createHash('sha1')
        .update(JSON.stringify({ models, providers }))
        .digest('hex')

      return { models, providers, catalogueSha, release: 'local' }
    }
  }
}
