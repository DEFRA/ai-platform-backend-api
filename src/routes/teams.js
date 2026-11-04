import Joi from 'joi'
import Boom from '@hapi/boom'

import { ACCESS } from '#/common/helpers/auth/access.js'
import {
  createTeam,
  listTeamsForUser,
  findTeamById,
  updateTeam,
  addMember,
  removeMember,
  setMemberRole
} from '#/services/team-service.js'

// Three characters, as the team file's schema requires; entered in any case
// and stored upper.
const serviceCodeField = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z0-9]{3}$/)

// Trimmed and optional; empty clears it.
const MAX_DESCRIPTION_LENGTH = 500
const MAX_EMAIL_LENGTH = 254
const descriptionField = Joi.string()
  .trim()
  .max(MAX_DESCRIPTION_LENGTH)
  .allow('')

const memberRoleField = Joi.string().valid('admin', 'user')

const idParam = Joi.object({ id: Joi.string().required() }).unknown(false)

const memberIdParam = Joi.object({
  id: Joi.string().required(),
  memberId: Joi.string().required()
}).unknown(false)

const idempotentHeaders = Joi.object({
  'idempotency-key': Joi.string().guid({ version: 'uuidv4' }).required()
}).unknown(true)

export const teams = [
  {
    method: 'POST',
    path: '/v1/teams',
    options: {
      app: { access: ACCESS.user },
      validate: {
        headers: idempotentHeaders,
        payload: Joi.object({
          name: Joi.string().trim().min(3).max(60).required(),
          serviceCode: serviceCodeField.required(),
          description: descriptionField.optional()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const idempotencyKey = request.headers['idempotency-key']
      const { name, serviceCode, description } = request.payload

      const { team, replay } = await createTeam(request.db, {
        name,
        serviceCode,
        description,
        actor: request.auth.credentials,
        idempotencyKey
      })

      const response = h.response({ team })

      if (!replay) {
        response.header('Location', `/v1/teams/${team._id}`)
      }

      return response.code(replay ? 200 : 201)
    }
  },
  {
    method: 'GET',
    path: '/v1/teams',
    options: { app: { access: ACCESS.user } },
    handler: async (request, h) => {
      const items = await listTeamsForUser(request.db, request.auth.credentials)

      return h.response({ items })
    }
  },
  {
    method: 'GET',
    path: '/v1/teams/{id}',
    options: {
      app: { access: ACCESS.teamMember },
      validate: { params: idParam }
    },
    handler: async (request, h) => {
      const result = await findTeamById(request.db, {
        id: request.params.id,
        actor: request.auth.credentials
      })

      if (!result) {
        return Boom.notFound()
      }

      return h.response(result)
    }
  },
  {
    method: 'PATCH',
    path: '/v1/teams/{id}',
    options: {
      app: { access: ACCESS.teamAdmin },
      validate: {
        params: idParam,
        payload: Joi.object({
          serviceCode: serviceCodeField,
          description: descriptionField
        })
          .or('serviceCode', 'description')
          .unknown(false)
      }
    },
    handler: async (request, h) => {
      const { team } = await updateTeam(request.db, {
        teamId: request.params.id,
        actor: request.auth.credentials,
        serviceCode: request.payload.serviceCode,
        description: request.payload.description
      })

      return h.response({ team })
    }
  },
  {
    method: 'POST',
    path: '/v1/teams/{id}/members',
    options: {
      app: { access: ACCESS.teamAdmin },
      validate: {
        headers: idempotentHeaders,
        params: idParam,
        payload: Joi.object({
          email: Joi.string().email().max(MAX_EMAIL_LENGTH).required(),
          role: memberRoleField.default('user')
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const member = await addMember(request.db, {
        teamId: request.params.id,
        actor: request.auth.credentials,
        idempotencyKey: request.headers['idempotency-key'],
        email: request.payload.email,
        role: request.payload.role
      })

      return h
        .response({ member })
        .header('Location', `/v1/teams/${request.params.id}/members`)
        .code(201)
    }
  },
  {
    method: 'PATCH',
    path: '/v1/teams/{id}/members/{memberId}',
    options: {
      app: { access: ACCESS.teamAdmin },
      validate: {
        params: memberIdParam,
        payload: Joi.object({
          role: memberRoleField.required()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const { member } = await setMemberRole(request.db, request.locker, {
        teamId: request.params.id,
        actor: request.auth.credentials,
        memberId: request.params.memberId,
        role: request.payload.role
      })

      return h.response({ member })
    }
  },
  {
    method: 'DELETE',
    path: '/v1/teams/{id}/members/{memberId}',
    options: {
      app: { access: ACCESS.teamAdmin },
      validate: { params: memberIdParam }
    },
    handler: async (request, h) => {
      await removeMember(request.db, request.locker, {
        teamId: request.params.id,
        actor: request.auth.credentials,
        memberId: request.params.memberId
      })

      return h.response().code(204)
    }
  }
]
