import Joi from 'joi'
import Boom from '@hapi/boom'

import { listModels, findModelBySlug } from '#/services/models-service.js'
import { listTeamModels } from '#/services/catalogue-service.js'

const TEAM_TIER = 'team'

export const models = [
  {
    method: 'GET',
    path: '/v1/models',
    options: {
      validate: {
        query: Joi.object({
          provider: Joi.string().trim().lowercase(),
          tier: Joi.string().trim().lowercase(),
          // Only for `tier=team`, where it keeps the models a team can have
          // in that environment (D4).
          environment: Joi.string()
            .trim()
            .lowercase()
            .pattern(/^[a-z0-9-]+$/)
            .when('tier', { is: TEAM_TIER, otherwise: Joi.forbidden() }),
          includeIneligible: Joi.boolean().default(false)
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const { provider, tier, environment, includeIneligible } = request.query
      const items =
        tier === TEAM_TIER
          ? await listTeamModels(request.db, { provider, environment })
          : await listModels(request.db, { provider, tier, includeIneligible })

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
