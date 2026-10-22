import Joi from 'joi'
import Boom from '@hapi/boom'

import { findModelBySlug } from '#/services/models-service.js'
import {
  listModelsWithResearchAvailability,
  listResearchModels,
  listTeamModels
} from '#/services/catalogue-service.js'

const TEAM_TIER = 'team'
const RESEARCH_TIER = 'research'

// `tier=team` keeps only the models a team can really have (no Global SKU, UK
// or EU regions only); `tier=research` only those research-eligible and
// deployed in the research environment. Any other query is the plain list,
// each model with `researchAvailable` (true only when it is research-eligible
// and deployed in the research environment), so a page can still say why a
// model is not offered. Both research lists answer `502
// research-deployments-unavailable` when the deployed models cannot be read.
function listForTier(db, { provider, tier, environment, includeIneligible }) {
  if (tier === TEAM_TIER) {
    return listTeamModels(db, { provider, environment })
  }

  if (tier === RESEARCH_TIER) {
    return listResearchModels(db, { provider })
  }

  return listModelsWithResearchAvailability(db, {
    provider,
    tier,
    includeIneligible
  })
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
