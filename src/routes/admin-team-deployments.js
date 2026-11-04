import Joi from 'joi'

import { statusCodes } from '#/common/constants/status-codes.js'
import { ACCESS } from '#/common/helpers/auth/access.js'
import { redispatchApply } from '#/services/team-deployment-service.js'

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
      app: { access: ACCESS.platformAdmin },
      validate: { params: idParam }
    },
    handler: async (request, h) => {
      const deployment = await redispatchApply(
        request.db,
        {
          id: request.params.id,
          actor: request.auth.credentials,
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
