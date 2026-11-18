import Joi from 'joi'

import { ACCESS } from '#/common/helpers/auth/access.js'
import { environmentName } from '#/common/helpers/environment-name.js'
import { failActionWithCode } from '#/common/helpers/fail-action.js'
import {
  DEFAULT_STATUS_CHANGES_LIMIT,
  MAX_STATUS_CHANGES_LIMIT,
  listStatusChanges
} from '#/services/team-status-changes.js'

export const teamStatusChanges = [
  {
    method: 'GET',
    path: '/v1/teams/{teamId}/status-changes',
    options: {
      app: { access: ACCESS.teamMember },
      description:
        "When a Platform Admin disabled or enabled the team, newest first: `{items: [{change: 'disabled'|'enabled', environments, at}]}`, `limit` 1 to 50 (default 10), `environment` keeps the changes that name it. Never the reason or who did it. Any member; a non-member gets 404, audited; a bad query is 400 `invalid-query`.",
      validate: {
        params: Joi.object({ teamId: Joi.string().required() }).unknown(false),
        query: Joi.object({
          environment: environmentName,
          limit: Joi.number()
            .integer()
            .min(1)
            .max(MAX_STATUS_CHANGES_LIMIT)
            .default(DEFAULT_STATUS_CHANGES_LIMIT)
        }).unknown(false),
        failAction: failActionWithCode(
          'invalid-query',
          'The environment or limit is not valid'
        )
      }
    },
    handler: async (request, h) =>
      h.response(
        await listStatusChanges(request.db, {
          teamId: request.params.teamId,
          actor: request.auth.credentials,
          environment: request.query.environment,
          limit: request.query.limit
        })
      )
  }
]
