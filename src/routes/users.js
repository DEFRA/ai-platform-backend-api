import Joi from 'joi'

import { upsertUser } from '#/services/user-service.js'

export const users = {
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
}
