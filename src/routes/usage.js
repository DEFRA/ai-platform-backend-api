import Joi from 'joi'

import { ACCESS } from '#/common/helpers/auth/access.js'
import { environmentName } from '#/common/helpers/environment-name.js'
import { failActionWithCode } from '#/common/helpers/fail-action.js'
import {
  getAdminUsage,
  getKeyUsage,
  getTeamUsage,
  getTeamUsageOverview,
  getUserUsageSummary
} from '#/services/usage-service.js'

const DAYS_IN_WEEK = 7
const DAYS_IN_MONTH = 30
const DAYS_IN_QUARTER = 90
const USAGE_DAYS = [DAYS_IN_WEEK, DAYS_IN_MONTH, DAYS_IN_QUARTER]
const DEFAULT_DAYS = DAYS_IN_MONTH

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
    path: '/v1/teams/{teamId}/usage',
    options: {
      app: { access: ACCESS.teamMember },
      description:
        "A team's usage across every environment this instance offers: a figure for each of the last six months, and for this month the totals, a forecast at the rate so far, the share by environment and model, the tokens of each day and what needs attention. Counts and estimates only. Any member; a non-member gets 404, a team with no usage source in any environment 404 `usage-not-available`.",
      validate: {
        params: Joi.object({ teamId: Joi.string().required() }).unknown(false),
        failAction: invalidQuery
      }
    },
    handler: async (request, h) =>
      h.response(
        await getTeamUsageOverview(request.db, {
          teamId: request.params.teamId,
          actor: request.auth.credentials
        })
      )
  },
  {
    method: 'GET',
    path: '/v1/users/me/usage',
    options: {
      app: { access: ACCESS.user },
      description:
        "This month's tokens, estimated cost, forecast and what needs attention, for each team the signed-in person belongs to. A team whose usage cannot be read is listed with the reason."
    },
    handler: async (request, h) =>
      h.response(
        await getUserUsageSummary(request.db, {
          actor: request.auth.credentials
        })
      )
  },
  {
    method: 'GET',
    path: '/v1/credentials/{id}/usage',
    options: {
      app: { access: ACCESS.credentialOwner },
      description:
        "A personal (Research tier) key's usage over the last 7, 30 or 90 days, and when it ends. Counts only. The owner; anyone else gets 404, audited.",
      validate: {
        params: Joi.object({ id: Joi.string().required() }).unknown(false),
        query,
        failAction: invalidQuery
      }
    },
    handler: async (request, h) =>
      h.response(
        await getKeyUsage(request.db, {
          id: request.params.id,
          days: request.query.days,
          actor: request.auth.credentials
        })
      )
  },
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
