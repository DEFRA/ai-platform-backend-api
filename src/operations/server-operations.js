import { gitopsSettings } from '#/operations/gitops-settings.js'
import { createOperationsRuntime } from '#/operations/operations-runtime.js'

const DRAIN_TIMEOUT_MS = 5000

// Waits for the running sweeps, but never longer than the bound.
async function drainSweeps(sweeps, timeoutMs) {
  if (sweeps.size === 0) {
    return
  }

  let timer
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })

  try {
    await Promise.race([Promise.allSettled([...sweeps]), bound])
  } finally {
    clearTimeout(timer)
  }
}

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
 * @param {number} [deps.drainTimeoutMs] - how long `stop` waits for a running sweep
 */
export function createServerOperations({
  db,
  locker,
  logger,
  registry,
  verifier,
  buildDocument,
  grantCredentials,
  settings = gitopsSettings(),
  drainTimeoutMs = DRAIN_TIMEOUT_MS
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
  const inFlight = new Set()

  function every(name, intervalMs, task) {
    let running = false
    const timer = setInterval(() => {
      if (running) {
        return
      }

      running = true

      const sweep = (async () => {
        try {
          await task()
        } catch (error) {
          logger?.error({ message: error.message }, `The ${name} failed`)
        } finally {
          running = false
          inFlight.delete(sweep)
        }
      })()

      inFlight.add(sweep)
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
     * A sweep already running is given `drainTimeoutMs` to finish, so the
     * database is not closed under it; a stuck one never holds shutdown past
     * that.
     */
    async stop() {
      for (const timer of timers.splice(0)) {
        clearInterval(timer)
      }

      await drainSweeps(inFlight, drainTimeoutMs)
      await transport.stop()
    }
  }
}
