import { config } from '#/config.js'
import { mockTenantOrchestrator } from '#/adapters/mock-tenant-orchestrator.js'
import { createGithubTenantOrchestrator } from '#/adapters/github/github-tenant-orchestrator.js'

export const MOCK_ORCHESTRATOR = 'mock'
export const GITHUB_ORCHESTRATOR = 'github'

/**
 * @typedef {object} TenantOrchestratorRegistry
 * @property {string} key - the orchestrator new deployments are submitted through, persisted on each entry
 * @property {import('#/adapters/tenant-orchestrator.js').TenantOrchestrator} orchestrator - the orchestrator for `key`
 * @property {(entry: {orchestrator?: string}) => import('#/adapters/tenant-orchestrator.js').TenantOrchestrator} forEntry - the orchestrator that submitted an existing entry
 */

/**
 * Creates the registry that picks the `TenantOrchestrator` for new team
 * deployments from `TENANT_ORCHESTRATOR`, and resolves an existing entry to
 * the orchestrator that submitted it (as credentials keep their
 * `issuerKey`), so switching modes never sends an old mock entry to GitHub.
 * Refuses to start with the mock in the prod environment.
 * @param {Record<string, import('#/adapters/tenant-orchestrator.js').TenantOrchestrator>} orchestratorsByKey
 * @param {string} mode
 * @param {string} cdpEnvironment
 * @returns {TenantOrchestratorRegistry}
 */
export function createTenantOrchestratorRegistry(
  orchestratorsByKey,
  mode,
  cdpEnvironment
) {
  if (cdpEnvironment === 'prod' && mode === MOCK_ORCHESTRATOR) {
    throw new Error(
      'TENANT_ORCHESTRATOR must not be "mock" in the prod environment'
    )
  }

  function resolve(key) {
    const orchestrator = orchestratorsByKey[key]

    if (!orchestrator) {
      throw new Error(`No tenant orchestrator registered for "${key}"`)
    }

    return orchestrator
  }

  return {
    key: mode,
    orchestrator: resolve(mode),
    forEntry(entry) {
      return resolve(entry?.orchestrator ?? MOCK_ORCHESTRATOR)
    }
  }
}

/**
 * The live registry, built from config at startup. The GitHub adapter
 * builds its clients lazily, so it is safe to register in mock mode.
 * @type {TenantOrchestratorRegistry}
 */
export const tenantOrchestratorRegistry = createTenantOrchestratorRegistry(
  {
    [MOCK_ORCHESTRATOR]: mockTenantOrchestrator,
    [GITHUB_ORCHESTRATOR]: createGithubTenantOrchestrator()
  },
  config.get('tenantOrchestrator'),
  config.get('cdpEnvironment')
)
