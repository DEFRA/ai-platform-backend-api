import { config } from '#/config.js'
import { mockTeamFileReader } from '#/adapters/mock-team-file-reader.js'
import {
  createMockTransport,
  mockOutcomeOfPurpose
} from '#/adapters/mock-gitops-worker.js'
import { createGithubTeamFileReader } from '#/adapters/github/github-team-file-reader.js'
import { createSqsTransport } from '#/adapters/sqs/sqs-transport.js'

export const MOCK_ORCHESTRATOR = 'mock'
export const SQS_ORCHESTRATOR = 'sqs'

const NO_OUTCOME = () => null

/**
 * @typedef {object} TenantOrchestratorRegistry
 * @property {string} key - the orchestrator mode, `mock` or `sqs`
 * @property {import('#/adapters/team-file-reader.js').TeamFileReader} reader - how the team files are read
 * @property {(deps: {db: import('mongodb').Db, handle: (event: object) => Promise<unknown>, logger?: import('pino').Logger}) => {publisher: import('#/adapters/command-publisher.js').CommandPublisher, runReader: object, start: () => void, stop: () => Promise<void>}} createTransport - how commands go out and events come back
 * @property {(purpose: string|undefined) => 'checks-failed'|'deploy-failed'|null} mockOutcomeOf - the outcome a request's purpose forces; always null outside the mock
 */

/**
 * Creates the registry that picks how team changes reach the GitOps state
 * repositories, from `TENANT_ORCHESTRATOR`: `mock` stages the events itself
 * on a timer; `sqs` publishes commands to the GitOps worker's queue and reads
 * its events. Each mode also names how the team files are read. Refuses to
 * start with the mock in the prod environment.
 * @param {Record<string, {reader: object, createTransport: Function, mockOutcomeOf?: Function}>} adaptersByMode
 * @param {string} mode
 * @param {string} cdpEnvironment
 * @returns {TenantOrchestratorRegistry}
 */
export function createTenantOrchestratorRegistry(
  adaptersByMode,
  mode,
  cdpEnvironment
) {
  if (cdpEnvironment === 'prod' && mode === MOCK_ORCHESTRATOR) {
    throw new Error(
      'TENANT_ORCHESTRATOR must not be "mock" in the prod environment'
    )
  }

  const adapters = adaptersByMode[mode]

  if (!adapters) {
    throw new Error(`No tenant orchestrator registered for "${mode}"`)
  }

  return {
    key: mode,
    reader: adapters.reader,
    createTransport: adapters.createTransport,
    mockOutcomeOf: adapters.mockOutcomeOf ?? NO_OUTCOME
  }
}

/**
 * The live registry, built from config at startup. The GitHub reader and the
 * SQS transport build their clients lazily, so this is safe in mock mode.
 * @type {TenantOrchestratorRegistry}
 */
export const tenantOrchestratorRegistry = createTenantOrchestratorRegistry(
  {
    [MOCK_ORCHESTRATOR]: {
      reader: mockTeamFileReader,
      createTransport: createMockTransport,
      mockOutcomeOf: mockOutcomeOfPurpose
    },
    [SQS_ORCHESTRATOR]: {
      reader: createGithubTeamFileReader({
        tenantsRepo: config.get('gitops.tenantsRepo'),
        deploymentsRepo: config.get('gitops.deploymentsRepo')
      }),
      createTransport: createSqsTransport
    }
  },
  config.get('tenantOrchestrator'),
  config.get('cdpEnvironment')
)
