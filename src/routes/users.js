import Joi from 'joi'
import Boom from '@hapi/boom'

import { upsertUser, findCurrentUser } from '#/services/user-service.js'

export const users = [
  {
    method: 'POST',
    path: '/v1/users',
    options: {
      validate: {
        payload: Joi.object({
          email: Joi.string().email().max(254).required(),
          displayName: Joi.string().min(1).max(100).required(),
          teamName: Joi.string().min(1).max(100).required()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const { user, team } = await upsertUser(request.db, request.payload)

      return h.response({ user, team })
    }
  },
  {
    method: 'GET',
    path: '/v1/users/me',
    options: {
      validate: {
        headers: Joi.object({
          'x-user-id': Joi.string().required()
        }).unknown(true)
      }
    },
    handler: async (request, h) => {
      const result = await findCurrentUser(
        request.db,
        request.headers['x-user-id']
      )

      if (!result) {
        return Boom.notFound()
      }

      return h.response(result)
    }
  }
]
