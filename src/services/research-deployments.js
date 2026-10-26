import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import { config } from '#/config.js'
import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'

// The research tier is one platform-owned team file in `ai-platform-tenants`,
// `environments/{env}/research.json`: every deployment in it is a catalogue
// model offered to research, matched by `slug`, and the file is the deployed
// truth (the catalogue only says what research may have).
const RESEARCH_TEAM_SLUG = 'research'
const ACTIVE = 'active'

// One read in flight or recently finished, so a burst of requests shares it.
let cached = null

function researchFilePath() {
  return `environments/${config.get('research.environment')}/${RESEARCH_TEAM_SLUG}.json`
}

async function readDeployedSlugs(registry, path) {
  try {
    const { document } = await registry.reader.getCurrentDocument({
      path
    })

    return new Set(
      (document?.deployments ?? [])
        .filter((deployment) => deployment.status === ACTIVE)
        .map((deployment) => deployment.slug)
    )
  } catch (error) {
    // The message only: it names no token or user.
    createLogger().warn(
      { path, error: error.message },
      'Failed to read the research deployments'
    )

    throw boomWithCode(
      Boom.badGateway,
      'Failed to read the models deployed for research',
      'research-deployments-unavailable'
    )
  }
}

/**
 * Starts a read that every request shares until it settles: it stays in the
 * cache without an expiry while pending, and only once it succeeds does
 * `research.deploymentsCacheMs` start counting; a failed read leaves the cache.
 */
function startRead(registry, path) {
  const entry = { registry, path, expiresAt: Infinity }

  entry.slugs = readDeployedSlugs(registry, path).then(
    (slugs) => {
      entry.expiresAt = Date.now() + config.get('research.deploymentsCacheMs')

      return slugs
    },
    (error) => {
      if (cached === entry) {
        cached = null
      }

      throw error
    }
  )

  return entry
}

/**
 * The slugs of the models deployed in the research environment: those whose
 * deployment is `active` in its `research.json` on `ai-platform-tenants`. No
 * file means nothing is deployed, so an empty set. Cached for
 * `research.deploymentsCacheMs`; a failed read is never cached.
 * @param {{registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} [deps]
 * @returns {Promise<ReadonlySet<string>>}
 * @throws {Error} `502 research-deployments-unavailable` when the file cannot be read
 */
export async function readResearchDeployments({
  registry = tenantOrchestratorRegistry
} = {}) {
  const path = researchFilePath()

  if (
    cached?.registry !== registry ||
    cached.path !== path ||
    cached.expiresAt <= Date.now()
  ) {
    cached = startRead(registry, path)
  }

  return cached.slugs
}

/**
 * Forgets the cached research deployments, so the next read goes to the
 * team file reader. For tests.
 */
export function clearResearchDeploymentsCache() {
  cached = null
}
