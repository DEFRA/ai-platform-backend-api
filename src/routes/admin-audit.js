import Joi from 'joi'

import { ACCESS } from '#/common/helpers/auth/access.js'
import { failActionWithCode } from '#/common/helpers/fail-action.js'
import { ACTOR_TYPES, listAuditEvents } from '#/services/admin-audit-service.js'

// What a Platform Admin types into the filters: the same bounds as a person
// search for a name, and a plain action code (`team.removeMember`).
const MIN_PERSON_LENGTH = 2
const MAX_PERSON_LENGTH = 100
const MAX_TEAM_LENGTH = 100
const MAX_ACTION_LENGTH = 64
const ENVIRONMENT_PATTERN = /^[a-z0-9-]{1,40}$/
const ACTION_PATTERN = /^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*){1,3}$/

const invalidQuery = failActionWithCode(
  'invalid-query',
  'The filters or page are not valid'
)

const listQuery = Joi.object({
  team: Joi.string().min(1).max(MAX_TEAM_LENGTH),
  environment: Joi.string().pattern(ENVIRONMENT_PATTERN),
  person: Joi.string().trim().min(MIN_PERSON_LENGTH).max(MAX_PERSON_LENGTH),
  action: Joi.string().max(MAX_ACTION_LENGTH).pattern(ACTION_PATTERN),
  actorType: Joi.string().valid(...ACTOR_TYPES),
  from: Joi.date().iso(),
  // Both ends are inclusive, so a range of one instant is allowed.
  to: Joi.date()
    .iso()
    .when('from', { is: Joi.exist(), then: Joi.date().min(Joi.ref('from')) }),
  page: Joi.number().integer().min(1)
}).unknown(false)

// The Audit log tab of the Platform Admin area (design F, B31). The route
// declares `ACCESS.platformAdmin`; the service refuses and audits anyone else.
export const adminAudit = [
  {
    method: 'GET',
    path: '/v1/admin/audit',
    options: {
      app: { access: ACCESS.platformAdmin },
      validate: { query: listQuery, failAction: invalidQuery }
    },
    handler: async (request, h) => {
      return h.response(
        await listAuditEvents(request.db, {
          actor: request.auth.credentials,
          ...request.query
        })
      )
    }
  }
]
