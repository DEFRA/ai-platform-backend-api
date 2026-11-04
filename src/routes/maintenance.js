import Joi from 'joi'
import Boom from '@hapi/boom'

import { config } from '#/config.js'
import { ACCESS } from '#/common/helpers/auth/access.js'
import {
  expireCredentials,
  reconcilePendingCredentials,
  flagStraySubscriptions
} from '#/services/maintenance-service.js'

// No Entra token: the caller is a scheduler that holds the shared
// `x-maintenance-token`, as B04 built it.
export const maintenance = {
  method: 'POST',
  path: '/maintenance/expire-credentials',
  options: {
    auth: false,
    app: { access: ACCESS.public },
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
      request.db,
      request.locker
    )

    const straySubscriptions = await flagStraySubscriptions(request.logger)

    return h.response({
      expired,
      suspended,
      reconciled,
      vaultReconciled,
      straySubscriptions
    })
  }
}
