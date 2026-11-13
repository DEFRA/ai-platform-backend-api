import Joi from 'joi'

import { statusCodes } from '#/common/constants/status-codes.js'
import { ACCESS } from '#/common/helpers/auth/access.js'
import { failActionWithCode } from '#/common/helpers/fail-action.js'
import {
  CREDENTIAL_FILTERS,
  DEPLOYMENT_STATUS_FILTERS,
  getTeamDeployment,
  listTeamDeployments
} from '#/services/admin-deployment-service.js'
import {
  disableCredentials,
  enableCredentials,
  revokeCredentials
} from '#/services/admin-credential-service.js'
import { redispatchApply } from '#/services/team-deployment-service.js'
import { idempotentHeaders } from '#/routes/member-schemas.js'
import { reasonFailAction, reasonPayload } from '#/routes/admin-reason.js'

const MIN_SEARCH_LENGTH = 2
const MAX_SEARCH_LENGTH = 100
const MAX_ID_LENGTH = 100
const MAX_ENVIRONMENT_LENGTH = 50

const BASE = '/v1/admin/team-deployments'

const invalidQuery = failActionWithCode(
  'invalid-query',
  'The environment, search, model, status, credential or page is not valid'
)

const idParam = Joi.object({ id: Joi.string().required() }).unknown(false)

const deploymentParams = Joi.object({
  teamId: Joi.string().max(MAX_ID_LENGTH).required(),
  environment: Joi.string().max(MAX_ENVIRONMENT_LENGTH).required()
}).unknown(false)

const listQuery = Joi.object({
  environment: Joi.string().max(MAX_ENVIRONMENT_LENGTH),
  search: Joi.string().trim().min(MIN_SEARCH_LENGTH).max(MAX_SEARCH_LENGTH),
  model: Joi.string().max(MAX_ID_LENGTH),
  status: Joi.string().valid(...DEPLOYMENT_STATUS_FILTERS),
  credential: Joi.string().valid(...CREDENTIAL_FILTERS),
  page: Joi.number().integer().min(1)
}).unknown(false)

// Enable takes no body: nothing, or an empty object.
const emptyPayload = Joi.object({}).unknown(false).allow(null)

// Retry and reconcile go through the deployment's operation, for Platform
// Admins only: a retry by state (a fresh apply once committed, a submit
// before), a reconcile asks the worker what GitHub holds (D6, D14). 202: the
// command runs asynchronously and the deployment's status shows its progress.
function redispatchRoute(kind) {
  return {
    method: 'POST',
    path: `${BASE}/{id}/${kind}`,
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

// An action on a team's credentials in one environment. A person who ticks
// several environments makes one call for each (B31 "Several environments").
function credentialRoute(action, { takesReason, perform }) {
  return {
    method: 'POST',
    path: `${BASE}/{teamId}/{environment}/credentials/${action}`,
    options: {
      app: { access: ACCESS.platformAdmin },
      validate: takesReason
        ? {
            headers: idempotentHeaders,
            params: deploymentParams,
            payload: reasonPayload,
            failAction: reasonFailAction
          }
        : { params: deploymentParams, payload: emptyPayload }
    },
    handler: async (request, h) =>
      h.response(
        await perform(request, {
          actor: request.auth.credentials,
          teamId: request.params.teamId,
          environment: request.params.environment,
          ...(takesReason && {
            reason: request.payload.reason,
            idempotencyKey: request.headers['idempotency-key']
          })
        })
      )
  }
}

// The Deployments tab of the Platform Admin area (design F, B31). Every route
// here declares `ACCESS.platformAdmin`; the service refuses and audits anyone
// else.
export const adminTeamDeployments = [
  {
    method: 'GET',
    path: BASE,
    options: {
      app: { access: ACCESS.platformAdmin },
      validate: { query: listQuery, failAction: invalidQuery }
    },
    handler: async (request, h) =>
      h.response(
        await listTeamDeployments(request.db, {
          actor: request.auth.credentials,
          ...request.query
        })
      )
  },
  {
    method: 'GET',
    path: `${BASE}/{teamId}/{environment}`,
    options: {
      app: { access: ACCESS.platformAdmin },
      validate: { params: deploymentParams }
    },
    handler: async (request, h) =>
      h.response(
        await getTeamDeployment(request.db, {
          actor: request.auth.credentials,
          teamId: request.params.teamId,
          environment: request.params.environment
        })
      )
  },
  credentialRoute('disable', {
    takesReason: true,
    perform: (request, params) =>
      disableCredentials(request.db, request.locker, params)
  }),
  credentialRoute('enable', {
    takesReason: false,
    perform: (request, params) =>
      enableCredentials(request.db, request.locker, params)
  }),
  credentialRoute('revoke', {
    takesReason: true,
    perform: (request, params) =>
      revokeCredentials(request.db, request.locker, params, {
        logger: request.logger
      })
  }),
  redispatchRoute('retry'),
  redispatchRoute('reconcile')
]
