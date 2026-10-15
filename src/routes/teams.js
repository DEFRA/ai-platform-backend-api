import Joi from 'joi'
import Boom from '@hapi/boom'

import {
  createTeam,
  listTeamsForUser,
  findTeamById,
  setServiceCode,
  addMember,
  removeMember,
  setMemberRole
} from '#/services/team-service.js'

// Three characters, as the team file's schema requires; entered in any case
// and stored upper.
const serviceCode = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z0-9]{3}$/)

const userIdHeader = Joi.object({
  'x-user-id': Joi.string().required()
}).unknown(true)

const idParam = Joi.object({ id: Joi.string().required() }).unknown(false)

const memberIdParam = Joi.object({
  id: Joi.string().required(),
  memberId: Joi.string().required()
}).unknown(false)

const idempotentHeaders = Joi.object({
  'x-user-id': Joi.string().required(),
  'idempotency-key': Joi.string().guid({ version: 'uuidv4' }).required()
}).unknown(true)

export const teams = [
  {
    method: 'POST',
    path: '/v1/teams',
    options: {
      validate: {
        headers: idempotentHeaders,
        payload: Joi.object({
          name: Joi.string().trim().min(3).max(60).required(),
          serviceCode: serviceCode.required(),
          description: Joi.string().trim().max(500).allow('').optional()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const createdBy = request.headers['x-user-id']
      const idempotencyKey = request.headers['idempotency-key']
      const { name, serviceCode, description } = request.payload

      const { team, replay } = await createTeam(request.db, {
        name,
        serviceCode,
        description,
        createdBy,
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
    options: {
      validate: { headers: userIdHeader }
    },
    handler: async (request, h) => {
      const items = await listTeamsForUser(
        request.db,
        request.headers['x-user-id']
      )

      return h.response({ items })
    }
  },
  {
    method: 'GET',
    path: '/v1/teams/{id}',
    options: {
      validate: { headers: userIdHeader, params: idParam }
    },
    handler: async (request, h) => {
      const result = await findTeamById(request.db, {
        id: request.params.id,
        userId: request.headers['x-user-id']
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
      validate: {
        headers: userIdHeader,
        params: idParam,
        payload: Joi.object({
          serviceCode: serviceCode.required()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const { team } = await setServiceCode(request.db, {
        teamId: request.params.id,
        actorUserId: request.headers['x-user-id'],
        serviceCode: request.payload.serviceCode
      })

      return h.response({ team })
    }
  },
  {
    method: 'POST',
    path: '/v1/teams/{id}/members',
    options: {
      validate: {
        headers: idempotentHeaders,
        params: idParam,
        payload: Joi.object({
          email: Joi.string().email().max(254).required()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const member = await addMember(request.db, {
        teamId: request.params.id,
        actorUserId: request.headers['x-user-id'],
        idempotencyKey: request.headers['idempotency-key'],
        email: request.payload.email
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
      validate: {
        headers: userIdHeader,
        params: memberIdParam,
        payload: Joi.object({
          role: Joi.string().valid('admin', 'user').required()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const { member } = await setMemberRole(request.db, request.locker, {
        teamId: request.params.id,
        actorUserId: request.headers['x-user-id'],
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
      validate: { headers: userIdHeader, params: memberIdParam }
    },
    handler: async (request, h) => {
      await removeMember(request.db, request.locker, {
        teamId: request.params.id,
        actorUserId: request.headers['x-user-id'],
        memberId: request.params.memberId
      })

      return h.response().code(204)
    }
  }
]
