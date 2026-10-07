import { config } from '#/config.js'
import {
  expireCredentials,
  reconcilePendingCredentials
} from '#/services/maintenance-service.js'

/**
 * Runs the same sweep as `POST /maintenance/expire-credentials` on an
 * in-process interval, so expiry enforcement doesn't depend on an external
 * caller hitting that route. `server.db`/`server.locker` are only read
 * inside the interval callback, so registration order relative to the
 * `mongodb` plugin doesn't matter.
 */
export const credentialExpiryScheduler = {
  plugin: {
    name: 'credential-expiry-scheduler',
    version: '1.0.0',
    register: function (server) {
      if (!config.get('maintenanceScheduler.enabled')) {
        server.logger.info('Credential expiry scheduler disabled')
        return
      }

      const intervalMs = config.get('maintenanceScheduler.intervalMs')
      server.logger.info({ intervalMs }, 'Credential expiry scheduler started')

      const timer = setInterval(async () => {
        try {
          const { expired, suspended } = await expireCredentials(
            server.db,
            server.locker,
            undefined,
            server.logger
          )
          const { reconciled, vaultReconciled } =
            await reconcilePendingCredentials(server.db)

          // Always log at debug so a sweep's absence of work is still observable;
          // escalate to info only when the sweep actually changed something.
          server.logger.debug(
            { expired, suspended, reconciled, vaultReconciled },
            'Credential expiry sweep ran'
          )
          if (expired || suspended || reconciled || vaultReconciled) {
            server.logger.info(
              { expired, suspended, reconciled, vaultReconciled },
              'Credential expiry sweep completed'
            )
          }
        } catch (error) {
          server.logger.error(error, 'Credential expiry sweep failed')
        }
      }, intervalMs)

      // Don't hold the process open just for this timer, and stop
      // scheduling further sweeps once the server starts shutting down.
      timer.unref()
      server.events.on('stop', () => clearInterval(timer))
    }
  }
}
