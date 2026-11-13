import Joi from 'joi'

import { statusCodes } from '#/common/constants/status-codes.js'
import { ACCESS } from '#/common/helpers/auth/access.js'
import { failActionWithCode } from '#/common/helpers/fail-action.js'
import { listAdminTeams, findAdminTeam } from '#/services/admin-team-service.js'
import {
  addMemberAsPlatformAdmin,
  removeMemberAsPlatformAdmin,
  searchPeopleAsPlatformAdmin
} from '#/services/admin-team-members.js'
import { TEAM_STATUS } from '#/services/team-status.js'
import {
  addMemberPayload,
  idempotentHeaders,
  personSearchPayload
} from '#/routes/member-schemas.js'

// What a Platform Admin types to find a team: the same bounds as a person
// search, so one rule for what a search box takes.
const MIN_SEARCH_LENGTH = 2
const MAX_SEARCH_LENGTH = 100
const MAX_ID_LENGTH = 100

const invalidQuery = failActionWithCode(
  'invalid-query',
  'The search, status or page is not valid'
)

const idParam = Joi.object({
  id: Joi.string().max(MAX_ID_LENGTH).required()
}).unknown(false)

const memberIdParam = Joi.object({
  id: Joi.string().max(MAX_ID_LENGTH).required(),
  memberId: Joi.string().max(MAX_ID_LENGTH).required()
}).unknown(false)

const listQuery = Joi.object({
  search: Joi.string().trim().min(MIN_SEARCH_LENGTH).max(MAX_SEARCH_LENGTH),
  status: Joi.string().valid(...Object.values(TEAM_STATUS)),
  page: Joi.number().integer().min(1)
}).unknown(false)

// The Teams tab of the Platform Admin area (design F, B31). Every route here
// declares `ACCESS.platformAdmin`; the service refuses and audits anyone else.
export const adminTeams = [
  {
    method: 'GET',
    path: '/v1/admin/teams',
    options: {
      app: { access: ACCESS.platformAdmin },
      validate: { query: listQuery, failAction: invalidQuery }
    },
    handler: async (request, h) => {
      const { search, status, page } = request.query

      return h.response(
        await listAdminTeams(request.db, {
          actor: request.auth.credentials,
          search,
          status,
          page
        })
      )
    }
  },
  {
    method: 'GET',
    path: '/v1/admin/teams/{id}',
    options: {
      app: { access: ACCESS.platformAdmin },
      validate: { params: idParam }
    },
    handler: async (request, h) => {
      return h.response(
        await findAdminTeam(request.db, {
          id: request.params.id,
          actor: request.auth.credentials
        })
      )
    }
  },
  {
    method: 'POST',
    path: '/v1/admin/teams/{id}/people/search',
    options: {
      app: { access: ACCESS.platformAdmin },
      validate: { params: idParam, payload: personSearchPayload }
    },
    handler: async (request, h) => {
      const { items } = await searchPeopleAsPlatformAdmin(request.db, {
        id: request.params.id,
        actor: request.auth.credentials,
        search: request.payload.search
      })

      return h.response({ items })
    }
  },
  {
    method: 'POST',
    path: '/v1/admin/teams/{id}/members',
    options: {
      app: { access: ACCESS.platformAdmin },
      validate: {
        headers: idempotentHeaders,
        params: idParam,
        payload: addMemberPayload
      }
    },
    handler: async (request, h) => {
      const member = await addMemberAsPlatformAdmin(request.db, {
        id: request.params.id,
        actor: request.auth.credentials,
        idempotencyKey: request.headers['idempotency-key'],
        oid: request.payload.oid,
        role: request.payload.role
      })

      return h
        .response({ member })
        .header('Location', `/v1/admin/teams/${request.params.id}`)
        .code(statusCodes.created)
    }
  },
  {
    method: 'DELETE',
    path: '/v1/admin/teams/{id}/members/{memberId}',
    options: {
      app: { access: ACCESS.platformAdmin },
      validate: { params: memberIdParam }
    },
    handler: async (request, h) => {
      await removeMemberAsPlatformAdmin(request.db, request.locker, {
        id: request.params.id,
        actor: request.auth.credentials,
        memberId: request.params.memberId
      })

      return h.response().code(statusCodes.noContent)
    }
  }
]
