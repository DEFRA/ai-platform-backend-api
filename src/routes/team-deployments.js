import Joi from 'joi'
import Boom from '@hapi/boom'

import {
  getDeployment,
  listDeploymentsForTeam,
  removeDeployment,
  requestDeployment
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
          // Any registry-shaped name; which ones this instance may deploy to
          // is configuration, refused as environment-not-available.
          environment: Joi.string()
            .pattern(/^[a-z][a-z0-9]{1,15}$/)
            .required()
        }).unknown(false)
      }
    },
    handler: async (request, h) => {
      const requestedBy = request.headers['x-user-id']
      const idempotencyKey = request.headers['idempotency-key']
      const { teamId } = request.params
      const { modelSlug, environment } = request.payload

      const deployment = await requestDeployment(request.db, request.locker, {
        teamId,
        modelSlug,
        environment,
        requestedBy,
        idempotencyKey,
        traceParent: request.headers.traceparent
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
      const items = await listDeploymentsForTeam(
        request.db,
        {
          teamId: request.params.teamId,
          userId: request.headers['x-user-id']
        },
        { logger: request.logger }
      )

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
      const deployment = await getDeployment(
        request.db,
        {
          id: request.params.id,
          teamId: request.params.teamId,
          userId: request.headers['x-user-id']
        },
        { logger: request.logger }
      )

      if (!deployment) {
        return Boom.notFound()
      }

      return h.response({ deployment })
    }
  },
  {
    method: 'DELETE',
    path: '/v1/teams/{teamId}/deployments/{id}',
    options: {
      description:
        'Removes a model deployment (team admin): the team file is submitted without it and the next apply destroys it. 202 while the removal is in progress, 200 once removed.',
      validate: { headers: userIdHeader, params: idsParam }
    },
    handler: async (request, h) => {
      const deployment = await removeDeployment(request.db, request.locker, {
        teamId: request.params.teamId,
        id: request.params.id,
        requestedBy: request.headers['x-user-id'],
        traceParent: request.headers.traceparent
      })

      if (!deployment) {
        return Boom.notFound()
      }

      return h
        .response({ deployment })
        .code(deployment.status === 'removing' ? 202 : 200)
    }
  }
]
