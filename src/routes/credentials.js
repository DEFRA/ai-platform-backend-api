import Joi from 'joi'
import Boom from '@hapi/boom'

import { statusCodes } from '#/common/constants/status-codes.js'
import { ACCESS } from '#/common/helpers/auth/access.js'
import {
  issueCredential,
  listCredentials,
  findCredentialForViewing,
  renewCredential,
  rotateCredential,
  revokeCredential,
  revealCredential
} from '#/services/credential-service.js'

const MAX_PURPOSE_LENGTH = 500
const MAX_REVEAL_REASON_LENGTH = 500

const idParam = Joi.object({ id: Joi.string().required() }).unknown(false)

export const credentials = [
  {
    method: 'POST',
    path: '/v1/credentials',
    options: {
      app: { access: ACCESS.user },
      validate: {
        headers: Joi.object({
          'idempotency-key': Joi.string().guid({ version: 'uuidv4' }).required()
        }).unknown(true),
        payload: Joi.object({
          modelSlug: Joi.string()
            .pattern(/^[a-z0-9-]+$/)
            .required(),
          // Only a personal research key is issued by request. A team's
          // credential is created when its first model in an environment
          // turns active, so `team` is refused here.
          tier: Joi.string().valid('research').default('research'),
          // Any registry-shaped name; a research key defaults to the
          // configured research environment (the service refuses any other).
          environment: Joi.string()
            .pattern(/^[a-z][a-z0-9]{1,15}$/)
            .optional(),
          purpose: Joi.string()
            .trim()
            .max(MAX_PURPOSE_LENGTH)
            .allow('')
            .optional()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const idempotencyKey = request.headers['idempotency-key']
      const { modelSlug, environment, purpose } = request.payload

      const { credential, secret, replay } = await issueCredential(
        request.db,
        request.locker,
        {
          actor: request.auth.credentials,
          modelSlug,
          environment,
          purpose,
          idempotencyKey
        }
      )

      const response = h.response({ credential, secret })

      if (!replay) {
        response.header('Location', `/v1/credentials/${credential._id}`)
      }

      return response.code(replay ? statusCodes.ok : statusCodes.created)
    }
  },
  {
    method: 'GET',
    path: '/v1/credentials',
    options: { app: { access: ACCESS.user } },
    handler: async (request, h) => {
      const items = await listCredentials(request.db, {
        actor: request.auth.credentials
      })

      return h.response({ items })
    }
  },
  {
    method: 'GET',
    path: '/v1/credentials/{id}',
    options: {
      app: { access: ACCESS.credentialOwnerOrTeamMember },
      validate: { params: idParam }
    },
    handler: async (request, h) => {
      const credential = await findCredentialForViewing(request.db, {
        id: request.params.id,
        actor: request.auth.credentials
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
      app: { access: ACCESS.credentialOwner },
      validate: { params: idParam }
    },
    handler: async (request, h) => {
      const credential = await renewCredential(request.db, request.locker, {
        id: request.params.id,
        actor: request.auth.credentials
      })

      return h.response(credential)
    }
  },
  {
    method: 'POST',
    path: '/v1/credentials/{id}/rotate',
    options: {
      app: { access: ACCESS.credentialOwnerOrTeamAdmin },
      validate: { params: idParam }
    },
    handler: async (request, h) => {
      const { credential, secret } = await rotateCredential(
        request.db,
        request.locker,
        {
          id: request.params.id,
          actor: request.auth.credentials
        }
      )

      return h.response({ credential, secret })
    }
  },
  {
    method: 'DELETE',
    path: '/v1/credentials/{id}',
    options: {
      app: { access: ACCESS.credentialOwnerOrTeamAdmin },
      validate: { params: idParam }
    },
    handler: async (request, h) => {
      await revokeCredential(request.db, request.locker, {
        id: request.params.id,
        actor: request.auth.credentials
      })

      return h.response().code(statusCodes.noContent)
    }
  },
  {
    method: 'POST',
    path: '/v1/credentials/{id}/reveal',
    options: {
      app: { access: ACCESS.credentialOwnerOrTeamAdmin },
      validate: {
        params: idParam,
        payload: Joi.object({
          reason: Joi.string().trim().max(MAX_REVEAL_REASON_LENGTH).required()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const secret = await revealCredential(request.db, {
        id: request.params.id,
        actor: request.auth.credentials,
        reason: request.payload.reason
      })

      return h
        .response({ secret })
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
    }
  }
]
