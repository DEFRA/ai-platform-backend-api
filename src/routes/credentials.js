import Joi from 'joi'
import Boom from '@hapi/boom'

import {
  issueCredential,
  listCredentials,
  findCredentialForViewing,
  renewCredential,
  revokeCredential
} from '#/services/credential-service.js'

const userIdHeader = Joi.object({
  'x-user-id': Joi.string().required()
}).unknown(true)

const idParam = Joi.object({ id: Joi.string().required() }).unknown(false)

export const credentials = [
  {
    method: 'POST',
    path: '/v1/credentials',
    options: {
      validate: {
        headers: Joi.object({
          'x-user-id': Joi.string().required(),
          'idempotency-key': Joi.string().guid({ version: 'uuidv4' }).required()
        }).unknown(true),
        payload: Joi.object({
          modelSlug: Joi.string()
            .pattern(/^[a-z0-9-]+$/)
            .required(),
          tier: Joi.string().valid('research', 'team').default('research'),
          teamId: Joi.string().when('tier', {
            is: 'team',
            then: Joi.required(),
            otherwise: Joi.forbidden()
          }),
          environment: Joi.string()
            .valid('dev', 'qa', 'preprod', 'prod', 'uat')
            .when('tier', {
              is: 'team',
              then: Joi.required(),
              otherwise: Joi.forbidden()
            }),
          purpose: Joi.string().trim().max(500).allow('').optional()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const userId = request.headers['x-user-id']
      const idempotencyKey = request.headers['idempotency-key']
      const { modelSlug, tier, teamId, environment, purpose } = request.payload

      const { credential, secret, replay } = await issueCredential(
        request.db,
        request.locker,
        {
          userId,
          modelSlug,
          tier,
          teamId,
          environment,
          purpose,
          idempotencyKey
        }
      )

      const response = h.response({ credential, secret })

      if (!replay) {
        response.header('Location', `/v1/credentials/${credential._id}`)
      }

      return response.code(replay ? 200 : 201)
    }
  },
  {
    method: 'GET',
    path: '/v1/credentials',
    options: {
      validate: { headers: userIdHeader }
    },
    handler: async (request, h) => {
      const items = await listCredentials(request.db, {
        userId: request.headers['x-user-id']
      })

      return h.response({ items })
    }
  },
  {
    method: 'GET',
    path: '/v1/credentials/{id}',
    options: {
      validate: { headers: userIdHeader, params: idParam }
    },
    handler: async (request, h) => {
      const credential = await findCredentialForViewing(request.db, {
        id: request.params.id,
        userId: request.headers['x-user-id']
      })

      if (!credential) {
        return Boom.notFound()
      }

      return h.response(credential)
    }
  },
  {
    method: 'POST',
    path: '/v1/credentials/{id}/renew',
    options: {
      validate: { headers: userIdHeader, params: idParam }
    },
    handler: async (request, h) => {
      const credential = await renewCredential(request.db, request.locker, {
        id: request.params.id,
        userId: request.headers['x-user-id']
      })

      return h.response(credential)
    }
  },
  {
    method: 'DELETE',
    path: '/v1/credentials/{id}',
    options: {
      validate: { headers: userIdHeader, params: idParam }
    },
    handler: async (request, h) => {
      await revokeCredential(request.db, request.locker, {
        id: request.params.id,
        userId: request.headers['x-user-id']
      })

      return h.response().code(204)
    }
  }
]
