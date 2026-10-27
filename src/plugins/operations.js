import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import { tenantResourceVerifier } from '#/adapters/tenant-resource-verifier-registry.js'
import { createServerOperations } from '#/operations/server-operations.js'
import { createCredentialGranter } from '#/services/team-credential-grant.js'
import { createDocumentBuilder } from '#/services/team-deployment-submission.js'
import { createTeamDesiredStateBuilder } from '#/services/team-desired-state.js'

/**
 * Creates the operations runtime over the server's database and starts it
 * with the server (plan 6.1): the outbox relay sweep, the deadline sweeper
 * under the MongoDB lock and, with `TENANT_ORCHESTRATOR=sqs`, the events
 * consumer; all stop gracefully before the server stops. The runtime is
 * `server.app.operations`; routes reach the operations service as
 * `request.operations`. It reads `server.db` and `server.locker`, so it is
 * registered after the `mongodb` plugin. The `registry` and `verifier`
 * options replace the configured ones, for a test; the registry's reader is
 * also what the documents are built from.
 */
export const operations = {
  plugin: {
    name: 'operations',
    version: '1.0.0',
    dependencies: ['mongodb'],
    register: function (server, options = {}) {
      const {
        registry = tenantOrchestratorRegistry,
        verifier = tenantResourceVerifier
      } = options
      const runtime = createServerOperations({
        db: server.db,
        locker: server.locker,
        logger: server.logger,
        registry,
        verifier,
        buildDocument: createDocumentBuilder(server.db, {
          buildDesiredState: createTeamDesiredStateBuilder({ registry })
        }),
        grantCredentials: createCredentialGranter({
          db: server.db,
          locker: server.locker,
          logger: server.logger
        })
      })

      server.app.operations = runtime
      server.decorate('request', 'operations', () => runtime.operations, {
        apply: true
      })

      server.events.on('start', () => {
        runtime.start()
        server.logger.info('Operations started')
      })
      server.ext('onPreStop', async () => {
        await runtime.stop()
      })
    }
  }
}
