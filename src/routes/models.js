import Joi from 'joi'
import Boom from '@hapi/boom'

import { listModels, findModelBySlug } from '#/services/models-service.js'

export const models = [
  {
    method: 'GET',
    path: '/v1/models',
    options: {
      validate: {
        query: Joi.object({
          provider: Joi.string().trim().lowercase(),
          tier: Joi.string().trim().lowercase(),
          includeIneligible: Joi.boolean().default(false)
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const { provider, tier, includeIneligible } = request.query
      const items = await listModels(request.db, {
        provider,
        tier,
        includeIneligible
      })

      return h.response({ items })
    }
  },
  {
    method: 'GET',
    path: '/v1/models/{slug}',
    options: {
      validate: {
        params: Joi.object({
          slug: Joi.string()
            .pattern(/^[a-z0-9-]+$/)
            .required()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const model = await findModelBySlug(request.db, request.params.slug)

      if (!model) {
        return Boom.notFound()
      }

      return h.response(model)
    }
  }
]
