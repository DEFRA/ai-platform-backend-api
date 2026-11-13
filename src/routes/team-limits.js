import Joi from 'joi'

import { statusCodes } from '#/common/constants/status-codes.js'
import { ACCESS } from '#/common/helpers/auth/access.js'
import { environmentName } from '#/common/helpers/environment-name.js'
import { changeTeamLimits } from '#/services/team-limits-service.js'

export const teamLimits = [
  {
    method: 'PUT',
    path: '/v1/teams/{teamId}/environments/{environment}/limits',
    options: {
      app: { access: ACCESS.teamAdmin },
      description:
        "Changes the team's token and request limits in one environment (team admin): one operation on the team's file. 202 with the operation and its Location; 200 for a replayed Idempotency-Key. Within the catalogue's bounds only (400 limits-out-of-bounds).",
      validate: {
        headers: Joi.object({
          'idempotency-key': Joi.string().guid({ version: 'uuidv4' }).required()
        }).unknown(true),
        params: Joi.object({
          teamId: Joi.string().required(),
          environment: environmentName.required()
        }).unknown(false),
        // Whole numbers; whether they sit within the bounds is the service's
        // to say, with the bounds in the answer.
        payload: Joi.object({
          tokensPerMinute: Joi.number().integer().required(),
          requestsPerMinute: Joi.number().integer().required()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const { teamId, environment } = request.params
      const { tokensPerMinute, requestsPerMinute } = request.payload

      const { operation, replay } = await changeTeamLimits(
        request.db,
        request.locker,
        {
          teamId,
          environment,
          limits: { tokensPerMinute, requestsPerMinute },
          actor: request.auth.credentials,
          idempotencyKey: request.headers['idempotency-key'],
          traceParent: request.headers.traceparent,
          cdpRequestId: request.headers['x-cdp-request-id']
        },
        { operations: request.operations }
      )

      return h
        .response({ operation })
        .header('Location', `/v1/teams/${teamId}/operations/${operation.id}`)
        .code(replay ? statusCodes.ok : statusCodes.accepted)
    }
  }
]
