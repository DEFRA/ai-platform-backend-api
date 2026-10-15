import Joi from 'joi'

import { statusCodes } from '#/common/constants/status-codes.js'
import { redispatchApply } from '#/services/team-deployment-service.js'

const userIdHeader = Joi.object({
  'x-user-id': Joi.string().required()
}).unknown(true)

const idParam = Joi.object({ id: Joi.string().required() }).unknown(false)

// Retry and reconcile are fresh apply dispatches on `main`, never re-runs
// (D6, D14), for Platform Admins only. 202: the apply runs asynchronously
// and the deployment's status shows its progress.
function redispatchRoute(kind) {
  return {
    method: 'POST',
    path: `/v1/admin/team-deployments/{id}/${kind}`,
    options: {
      validate: { headers: userIdHeader, params: idParam }
    },
    handler: async (request, h) => {
      const deployment = await redispatchApply(request.db, {
        id: request.params.id,
        actorUserId: request.headers['x-user-id'],
        kind
      })

      return h.response({ deployment }).code(statusCodes.accepted)
    }
  }
}

export const adminTeamDeployments = [
  redispatchRoute('retry'),
  redispatchRoute('reconcile')
]
