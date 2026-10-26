import { createCorroborator } from '#/operations/corroborator.js'
import { createDeadlineSweeper } from '#/operations/deadline-sweeper.js'
import { createEnvironmentControls } from '#/operations/environment-controls.js'
import { createEventsHandler } from '#/operations/events-handler.js'
import { createExternalOperations } from '#/operations/external-operations.js'
import { gitopsSettings } from '#/operations/gitops-settings.js'
import { createOperationVerifier } from '#/operations/operation-verifier.js'
import { createOperationsService } from '#/operations/operations-service.js'
import { createOutboxRelay } from '#/operations/outbox-relay.js'

/**
 * Wires the operations modules (plan 6.1) over their ports: the command
 * publisher, the team file reader, the run reader, the ARM verifier and the
 * credential grant. The ports are passed in, so a test or the mock mode
 * substitutes any of them.
 * @param {object} deps
 * @param {import('mongodb').Db} deps.db
 * @param {import('mongo-locks').LockManager} deps.locker
 * @param {import('pino').Logger} [deps.logger]
 * @param {ReturnType<typeof gitopsSettings>} [deps.settings]
 * @param {import('#/adapters/command-publisher.js').CommandPublisher} deps.publisher
 * @param {import('#/adapters/team-file-reader.js').TeamFileReader} deps.reader
 * @param {object} deps.runReader - the GitHub run reader
 * @param {import('#/adapters/tenant-resource-verifier.js').TenantResourceVerifier} deps.verifier
 * @param {(operation: object) => Promise<{document: object, expectedRevision?: number, expectedBase?: string|null}>} deps.buildDocument
 * @param {(operation: object) => Promise<void>} deps.grantCredentials
 */
export function createOperationsRuntime({
  db,
  locker,
  logger,
  settings = gitopsSettings(),
  publisher,
  reader,
  runReader,
  verifier,
  buildDocument,
  grantCredentials
}) {
  const ctx = { db, settings, logger }
  const relay = createOutboxRelay({ db, publisher, settings, logger })
  const corroborator = createCorroborator({
    runReader,
    repositories: settings.repositories
  })
  const controls = createEnvironmentControls({ db, corroborator, logger })
  const operations = createOperationsService({
    db,
    settings,
    relay,
    buildDocument,
    reader,
    controls,
    logger
  })
  const operationVerifier = createOperationVerifier({
    ctx,
    verifier,
    operations,
    grantCredentials
  })
  const external = createExternalOperations({
    db,
    corroborator,
    settings,
    logger
  })
  const handler = createEventsHandler({
    ctx,
    operations,
    verifier: operationVerifier,
    corroborator,
    controls,
    external
  })
  const sweeper = createDeadlineSweeper({
    ctx,
    locker,
    operations,
    verifier: operationVerifier,
    controls
  })

  return {
    relay,
    controls,
    operations,
    verifier: operationVerifier,
    external,
    handler,
    sweeper
  }
}
