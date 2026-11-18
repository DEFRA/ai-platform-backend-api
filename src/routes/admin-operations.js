import Joi from 'joi'

import { statusCodes } from '#/common/constants/status-codes.js'
import { ACCESS } from '#/common/helpers/auth/access.js'
import { redispatchOperation } from '#/services/admin-operation-service.js'

const MAX_ID_LENGTH = 100

const operationParams = Joi.object({
  operationId: Joi.string().max(MAX_ID_LENGTH).required()
}).unknown(false)

// 202: the command runs asynchronously and the operation's state shows its
// progress.
function operationRoute(kind, description) {
  return {
    method: 'POST',
    path: `/v1/admin/operations/{operationId}/${kind}`,
    options: {
      app: { access: ACCESS.platformAdmin },
      description,
      validate: { params: operationParams }
    },
    handler: async (request, h) =>
      h
        .response({
          operation: await redispatchOperation(
            request.db,
            {
              operationId: request.params.operationId,
              actor: request.auth.credentials,
              kind
            },
            { operations: request.operations }
          )
        })
        .code(statusCodes.accepted)
  }
}

// Recovers a change that holds no model, which the per-model routes cannot
// reach: a federation or limits change (design F, B31).
export const adminOperations = [
  operationRoute(
    'retry',
    "Retries a team's change by its id (Platform Admin): a failed apply gets a fresh apply, a timed-out change resumes, a held write is resubmitted. 202 `{operation: {id, state}}`; 404 `operation-not-found`; 409 `operation-not-retryable` for a change that has not failed, timed out or been held; 502 `upstream-unavailable`."
  ),
  operationRoute(
    'reconcile',
    "Asks the worker to report what GitHub holds for a team's change, in any state (Platform Admin). 202 `{operation: {id, state}}`; 404 `operation-not-found`; 502 `upstream-unavailable`."
  )
]
