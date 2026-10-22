import Joi from 'joi'
import Boom from '@hapi/boom'

import { listModels, findModelBySlug } from '#/services/models-service.js'
import {
  listResearchModels,
  listTeamModels
} from '#/services/catalogue-service.js'

const TEAM_TIER = 'team'
const RESEARCH_TIER = 'research'

// `tier=team` and `tier=research` keep only the models that tier can really
// use (no Global SKU, UK or EU regions only); any other query is the plain
// list, so a page can still say why a model is not offered.
function listForTier(db, { provider, tier, environment, includeIneligible }) {
  if (tier === TEAM_TIER) {
    return listTeamModels(db, { provider, environment })
  }

  if (tier === RESEARCH_TIER) {
    return listResearchModels(db, { provider })
  }

  return listModels(db, { provider, tier, includeIneligible })
}

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
          // in that environment.
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
      const items = await listForTier(request.db, {
        provider,
        tier,
        environment,
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
