import Joi from 'joi'

import { ACCESS } from '#/common/helpers/auth/access.js'
import {
  DEFAULT_OPERATIONS_LIMIT,
  MAX_OPERATIONS_LIMIT,
  getTeamOperation,
  listTeamOperations
} from '#/services/team-operations-service.js'

const teamParam = Joi.object({ teamId: Joi.string().required() }).unknown(false)

export const teamOperations = [
  {
    method: 'GET',
    path: '/v1/teams/{teamId}/operations',
    options: {
      app: { access: ACCESS.teamMember },
      description:
        "A team's changes to its files, newest first: `status` open ones hold the file, recent ones have ended. Any member; a non-member gets 404.",
      validate: {
        params: teamParam,
        query: Joi.object({
          // Any registry-shaped name; one the team has no changes in lists none.
          environment: Joi.string().pattern(/^[a-z][a-z0-9]{1,15}$/),
          status: Joi.string().valid('open', 'recent'),
          limit: Joi.number()
            .integer()
            .min(1)
            .max(MAX_OPERATIONS_LIMIT)
            .default(DEFAULT_OPERATIONS_LIMIT)
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const { environment, status, limit } = request.query

      return h.response(
        await listTeamOperations(request.db, {
          teamId: request.params.teamId,
          actor: request.auth.credentials,
          environment,
          status,
          limit
        })
      )
    }
  },
  {
    method: 'GET',
    path: '/v1/teams/{teamId}/operations/{operationId}',
    options: {
      app: { access: ACCESS.teamMember },
      description:
        "One of a team's changes to its files, with its steps. Any member; another team's operation id is 404.",
      validate: {
        params: Joi.object({
          teamId: Joi.string().required(),
          operationId: Joi.string().required()
        }).unknown(false)
      }
    },
    handler: async (request, h) =>
      h.response(
        await getTeamOperation(request.db, {
          teamId: request.params.teamId,
          operationId: request.params.operationId,
          actor: request.auth.credentials
        })
      )
  }
]
