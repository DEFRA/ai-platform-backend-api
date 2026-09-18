import Joi from 'joi'
import Boom from '@hapi/boom'

import { config } from '#/config.js'
import {
  expireCredentials,
  reconcilePendingCredentials
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
      request.locker
    )
    const { reconciled } = await reconcilePendingCredentials(request.db)

    return h.response({ expired, suspended, reconciled })
  }
}
