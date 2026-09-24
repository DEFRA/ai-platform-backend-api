import Joi from 'joi'
import Boom from '@hapi/boom'

import {
  createTeam,
  listTeamsForUser,
  findTeamById,
  addMember
} from '#/services/team-service.js'

const userIdHeader = Joi.object({
  'x-user-id': Joi.string().required()
}).unknown(true)

const idParam = Joi.object({ id: Joi.string().required() }).unknown(false)

export const teams = [
  {
    method: 'POST',
    path: '/v1/teams',
    options: {
      validate: {
        headers: Joi.object({
          'x-user-id': Joi.string().required(),
          'idempotency-key': Joi.string().guid({ version: 'uuidv4' }).required()
        }).unknown(true),
        payload: Joi.object({
          name: Joi.string().trim().min(3).max(60).required(),
          serviceCode: Joi.string().trim().max(20).allow('').optional(),
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
    method: 'POST',
    path: '/v1/teams/{id}/members',
    options: {
      validate: {
        headers: userIdHeader,
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
        email: request.payload.email
      })

      return h.response({ member }).code(201)
    }
  }
]
