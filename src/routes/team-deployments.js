import Joi from 'joi'
import Boom from '@hapi/boom'

import { statusCodes } from '#/common/constants/status-codes.js'
import { REMOVING } from '#/services/team-deployment-entries.js'
import {
  MAX_MODELS_PER_REQUEST,
  getDeployment,
  listDeploymentsForTeam,
  requestDeployments
} from '#/services/team-deployment-service.js'
import { removeDeployment } from '#/services/team-deployment-removal.js'

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
          modelSlugs: Joi.array()
            .items(Joi.string().pattern(/^[a-z0-9-]+$/))
            .min(1)
            .max(MAX_MODELS_PER_REQUEST)
            .unique()
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
      const { modelSlugs, environment } = request.payload

      const deployments = await requestDeployments(request.db, request.locker, {
        teamId,
        modelSlugs,
        environment,
        requestedBy,
        idempotencyKey,
        traceParent: request.headers.traceparent
      })

      return h
        .response({ deployments })
        .header('Location', `/v1/teams/${teamId}/deployments`)
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
        { logger: request.logger, locker: request.locker }
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
        { logger: request.logger, locker: request.locker }
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

      // A removal in flight is accepted; one already done is simply done.
      return h
        .response({ deployment })
        .code(
          deployment.status === REMOVING ? statusCodes.accepted : statusCodes.ok
        )
    }
  }
]
