import Joi from 'joi'
import Boom from '@hapi/boom'

import {
  requestDeployment,
  getDeployment,
  listDeploymentsForTeam
} from '#/services/team-deployment-service.js'

const userIdHeader = Joi.object({
  'x-user-id': Joi.string().required()
}).unknown(true)

const idsParam = Joi.object({
  teamId: Joi.string().required(),
  id: Joi.string().required()
}).unknown(false)

export const teamDeployments = [
  {
    method: 'POST',
    path: '/v1/teams/{teamId}/deployments',
    options: {
      validate: {
        headers: Joi.object({
          'x-user-id': Joi.string().required(),
          'idempotency-key': Joi.string().guid({ version: 'uuidv4' }).required()
        }).unknown(true),
        params: Joi.object({ teamId: Joi.string().required() }).unknown(false),
        payload: Joi.object({
          modelSlug: Joi.string()
            .pattern(/^[a-z0-9-]+$/)
            .required(),
          environment: Joi.string()
            .valid('dev', 'qa', 'preprod', 'prod', 'uat')
            .required()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const requestedBy = request.headers['x-user-id']
      const idempotencyKey = request.headers['idempotency-key']
      const { teamId } = request.params
      const { modelSlug, environment } = request.payload

      const deployment = await requestDeployment(request.db, {
        teamId,
        modelSlug,
        environment,
        requestedBy,
        idempotencyKey
      })

      return h
        .response({ deployment })
        .header('Location', `/v1/teams/${teamId}/deployments/${deployment._id}`)
        .code(201)
    }
  },
  {
    method: 'GET',
    path: '/v1/teams/{teamId}/deployments',
    options: {
      validate: {
        headers: userIdHeader,
        params: Joi.object({ teamId: Joi.string().required() }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const items = await listDeploymentsForTeam(request.db, {
        teamId: request.params.teamId,
        userId: request.headers['x-user-id']
      })

      return h.response({ items })
    }
  },
  {
    method: 'GET',
    path: '/v1/teams/{teamId}/deployments/{id}',
    options: {
      validate: { headers: userIdHeader, params: idsParam }
    },
    handler: async (request, h) => {
      const deployment = await getDeployment(request.db, {
        id: request.params.id,
        teamId: request.params.teamId,
        userId: request.headers['x-user-id']
      })

      if (!deployment) {
        return Boom.notFound()
      }

      return h.response({ deployment })
    }
  }
]
