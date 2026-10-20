import Joi from 'joi'
import Boom from '@hapi/boom'

import { config } from '#/config.js'
import {
  expireCredentials,
  reconcilePendingCredentials,
  flagStraySubscriptions
} from '#/services/maintenance-service.js'

export const maintenance = {
  method: 'POST',
  path: '/maintenance/expire-credentials',
  options: {
    validate: {
      headers: Joi.object({
        'x-maintenance-token': Joi.string().required()
      }).unknown(true)
    }
  },
  handler: async (request, h) => {
    if (
      request.headers['x-maintenance-token'] !== config.get('maintenanceToken')
    ) {
      return Boom.unauthorized()
    }

    const { expired, suspended } = await expireCredentials(
      request.db,
      request.locker,
      undefined,
      request.logger
    )
    const { reconciled, vaultReconciled } = await reconcilePendingCredentials(
      request.db
    )

    const straySubscriptions = await flagStraySubscriptions(
      undefined,
      request.logger
    )

    return h.response({
      expired,
      suspended,
      reconciled,
      vaultReconciled,
      straySubscriptions
    })
  }
}
