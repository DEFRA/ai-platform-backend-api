import Joi from 'joi'

import { statusCodes } from '#/common/constants/status-codes.js'
import { ACCESS } from '#/common/helpers/auth/access.js'
import { failActionWithCode } from '#/common/helpers/fail-action.js'
import { listAdminTeams, findAdminTeam } from '#/services/admin-team-service.js'
import { disableTeam, enableTeam } from '#/services/admin-team-lifecycle.js'
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
import { reasonField, reasonFailAction } from '#/routes/admin-reason.js'

// What a Platform Admin types to find a team: the same bounds as a person
// search, so one rule for what a search box takes.
const MIN_SEARCH_LENGTH = 2
const MAX_SEARCH_LENGTH = 100
const MAX_ID_LENGTH = 100

const invalidQuery = failActionWithCode(
  'invalid-query',
  'The search, status or page is not valid'
)

const invalidRequest = failActionWithCode(
  'invalid-request',
  'The request is not valid'
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

const disablePayload = Joi.object({ reason: reasonField }).unknown(false)

// Enable takes no reason and no environment: an empty body, or none.
const enablePayload = Joi.object({}).unknown(false).allow(null)

function lifecycleRoute(action, { description, validate, perform }) {
  return {
    method: 'POST',
    path: `/v1/admin/teams/{id}/${action}`,
    options: {
      app: { access: ACCESS.platformAdmin },
      description,
      validate: { params: idParam, ...validate }
    },
    handler: async (request, h) =>
      h.response(
        await perform(request, {
          id: request.params.id,
          actor: request.auth.credentials
        })
      )
  }
}

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
  },
  lifecycleRoute('disable', {
    description:
      'Disables a team (Platform Admin): its members can view it but not change its details or members (409 `team-disabled`). It is team-only: no environment changes, so its models, credentials and deployments keep working and can still be changed. Takes an Idempotency-Key and a `reason` of 1 to 500 characters, kept in the audit log only. 200 `{team: {id, status, disabledEnvironments}}`; a team already disabled, or a repeat of the key, changes and records nothing; the same key with another reason is 409 `idempotency-key-reused`; a team waiting to be removed is 409 `team-pending-removal`; 400 `reason-required`, `reason-too-long`, `invalid-request`; 404 `team-not-found`.',
    validate: {
      headers: idempotentHeaders,
      payload: disablePayload,
      failAction: reasonFailAction
    },
    perform: (request, params) =>
      disableTeam(request.db, request.locker, {
        ...params,
        reason: request.payload.reason,
        idempotencyKey: request.headers['idempotency-key']
      })
  }),
  lifecycleRoute('enable', {
    description:
      "Enables a team (Platform Admin), with no reason and no body: lifts the team lock. Never changes an environment or the block of the team's credentials. 200 `{team: {id, status, disabledEnvironments}}`; a team that is not disabled changes and records nothing; 400 `invalid-request`; 404 `team-not-found`.",
    validate: { payload: enablePayload, failAction: invalidRequest },
    perform: (request, params) => enableTeam(request.db, request.locker, params)
  })
]
