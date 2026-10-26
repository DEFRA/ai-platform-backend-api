import Joi from 'joi'

import { statusCodes } from '#/common/constants/status-codes.js'
import { redispatchApply } from '#/services/team-deployment-service.js'

const userIdHeader = Joi.object({
  'x-user-id': Joi.string().required()
}).unknown(true)

const idParam = Joi.object({ id: Joi.string().required() }).unknown(false)

// Retry and reconcile go through the deployment's operation, for Platform
// Admins only: a retry by state (a fresh apply once committed, a submit
// before), a reconcile asks the worker what GitHub holds (D6, D14). 202: the
// command runs asynchronously and the deployment's status shows its progress.
function redispatchRoute(kind) {
  return {
    method: 'POST',
    path: `/v1/admin/team-deployments/{id}/${kind}`,
    options: {
      validate: { headers: userIdHeader, params: idParam }
    },
    handler: async (request, h) => {
      const deployment = await redispatchApply(
        request.db,
        {
          id: request.params.id,
          actorUserId: request.headers['x-user-id'],
          kind
        },
        { operations: request.operations }
      )

      return h.response({ deployment }).code(statusCodes.accepted)
    }
  }
}

export const adminTeamDeployments = [
  redispatchRoute('retry'),
  redispatchRoute('reconcile')
]
