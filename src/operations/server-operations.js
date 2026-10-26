import { gitopsSettings } from '#/operations/gitops-settings.js'
import { createOperationsRuntime } from '#/operations/operations-runtime.js'

/**
 * The operations runtime as the server runs it: the wired modules over the
 * orchestrator's transport (the mock worker, or SQS), with the outbox relay
 * sweep, the deadline sweeper and, with SQS, the events consumer started and
 * stopped together. A sweep never overlaps itself, and a failed one is logged
 * and tried again at the next interval.
 * @param {object} deps
 * @param {import('mongodb').Db} deps.db
 * @param {import('mongo-locks').LockManager} deps.locker
 * @param {import('pino').Logger} [deps.logger]
 * @param {import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry} deps.registry
 * @param {import('#/adapters/tenant-resource-verifier.js').TenantResourceVerifier} deps.verifier
 * @param {Function} deps.buildDocument
 * @param {Function} deps.grantCredentials
 * @param {ReturnType<typeof gitopsSettings>} [deps.settings]
 */
export function createServerOperations({
  db,
  locker,
  logger,
  registry,
  verifier,
  buildDocument,
  grantCredentials,
  settings = gitopsSettings()
}) {
  const transport = registry.createTransport({
    db,
    logger,
    handle: (event) => runtime.handler.handle(event)
  })
  const runtime = createOperationsRuntime({
    db,
    locker,
    logger,
    settings,
    publisher: transport.publisher,
    reader: registry.reader,
    runReader: transport.runReader,
    verifier,
    buildDocument,
    grantCredentials
  })

  const timers = []

  function every(name, intervalMs, task) {
    let running = false
    const timer = setInterval(async () => {
      if (running) {
        return
      }

      running = true

      try {
        await task()
      } catch (error) {
        logger?.error({ message: error.message }, `The ${name} failed`)
      } finally {
        running = false
      }
    }, intervalMs)

    // Never holds the process open; the server stops it with the rest.
    timer.unref()
    timers.push(timer)
  }

  return {
    ...runtime,
    transport,

    /**
     * Starts the sweeps and, with SQS, the events consumer.
     */
    start() {
      every('outbox sweep', settings.outboxSweepMs, () => runtime.relay.sweep())
      every('deadline sweep', settings.sweepIntervalMs, () =>
        runtime.sweeper.sweep()
      )
      transport.start()
    },

    /**
     * Stops the sweeps and the transport, so the server can end gracefully.
     */
    async stop() {
      for (const timer of timers.splice(0)) {
        clearInterval(timer)
      }

      await transport.stop()
    }
  }
}
