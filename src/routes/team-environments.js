import Joi from 'joi'

import { ACCESS } from '#/common/helpers/auth/access.js'
import { environmentName } from '#/common/helpers/environment-name.js'
import {
  getTeamEnvironment,
  listTeamEnvironments
} from '#/services/team-environments-service.js'

export const teamEnvironments = [
  {
    method: 'GET',
    path: '/v1/teams/{teamId}/environments',
    options: {
      app: { access: ACCESS.teamMember },
      description:
        "Every environment this instance offers, with the team's models, limits and latest change in each, in order. Any member; a non-member gets 404.",
      validate: {
        params: Joi.object({ teamId: Joi.string().required() }).unknown(false)
      }
    },
    handler: async (request, h) =>
      h.response(
        await listTeamEnvironments(
          request.db,
          {
            teamId: request.params.teamId,
            actor: request.auth.credentials
          },
          { controls: request.server.app.operations.controls }
        )
      )
  },
  {
    method: 'GET',
    path: '/v1/teams/{teamId}/environments/{environment}',
    options: {
      app: { access: ACCESS.teamMember },
      description:
        'One environment in full: models, limits and the bounds to change them within, and the changes in progress. Any member; a non-member gets 404, an environment this instance does not offer 404 `environment-not-available`.',
      validate: {
        params: Joi.object({
          teamId: Joi.string().required(),
          environment: environmentName.required()
        }).unknown(false)
      }
    },
    handler: async (request, h) =>
      h.response(
        await getTeamEnvironment(
          request.db,
          {
            teamId: request.params.teamId,
            environment: request.params.environment,
            actor: request.auth.credentials
          },
          { controls: request.server.app.operations.controls }
        )
      )
  }
]
