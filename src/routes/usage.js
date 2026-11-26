import Joi from 'joi'

import { ACCESS } from '#/common/helpers/auth/access.js'
import { environmentName } from '#/common/helpers/environment-name.js'
import { failActionWithCode } from '#/common/helpers/fail-action.js'
import { getAdminUsage, getTeamUsage } from '#/services/usage-service.js'

const USAGE_DAYS = [7, 30, 90]
const DEFAULT_DAYS = 30

const invalidQuery = failActionWithCode(
  'invalid-query',
  'The environment or the number of days is not valid; days is 7, 30 or 90'
)

const query = Joi.object({
  days: Joi.number()
    .valid(...USAGE_DAYS)
    .default(DEFAULT_DAYS)
}).unknown(false)

export const usage = [
  {
    method: 'GET',
    path: '/v1/teams/{teamId}/environments/{environment}/usage',
    options: {
      app: { access: ACCESS.teamMember },
      description:
        "A team's usage in one environment over the last 7, 30 or 90 days: tokens and requests in total, for each day and for each model, with an estimated cost. Counts only. Any member; a non-member gets 404, an environment this instance does not offer 404 `environment-not-available`, one with no usage source 404 `usage-not-available`.",
      validate: {
        params: Joi.object({
          teamId: Joi.string().required(),
          environment: environmentName.required()
        }).unknown(false),
        query,
        failAction: invalidQuery
      }
    },
    handler: async (request, h) =>
      h.response(
        await getTeamUsage(request.db, {
          teamId: request.params.teamId,
          environment: request.params.environment,
          days: request.query.days,
          actor: request.auth.credentials
        })
      )
  },
  {
    method: 'GET',
    path: '/v1/admin/environments/{environment}/usage',
    options: {
      app: { access: ACCESS.platformAdmin },
      description:
        "Every team's usage in one environment over the last 7, 30 or 90 days, and the gateway APIs no team owns. Platform Admin only.",
      validate: {
        params: Joi.object({ environment: environmentName.required() }).unknown(
          false
        ),
        query,
        failAction: invalidQuery
      }
    },
    handler: async (request, h) =>
      h.response(
        await getAdminUsage(request.db, {
          environment: request.params.environment,
          days: request.query.days,
          actor: request.auth.credentials
        })
      )
  }
]
