import Joi from 'joi'

import { statusCodes } from '#/common/constants/status-codes.js'
import { ACCESS } from '#/common/helpers/auth/access.js'
import { environmentName } from '#/common/helpers/environment-name.js'
import {
  FEDERATION_HOSTS,
  MAX_FEDERATIONS
} from '#/services/team-federation-entries.js'
import {
  changeFederation,
  checkFederation,
  removeFederation,
  requestFederations
} from '#/services/team-federation-service.js'

// An application as the team file and the CDP name it: a CDP service as CDP
// names its repositories (at most 32 characters), an Azure application by a
// name of the file's own shape, and its managed identity by principal ID.
const MAX_SERVICE_LENGTH = 32
const MAX_ENVIRONMENTS = 5
const service = Joi.string()
  .pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(MAX_SERVICE_LENGTH)
const applicationName = Joi.string().pattern(/^[a-z0-9][a-z0-9-]{0,62}$/)
// The canonical form (8-4-4-4-12, no braces): Joi's `guid()` also accepts
// braces and no hyphens, which would make one principal two trust keys.
const principalId = Joi.string()
  .pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .lowercase()

const federationRequest = Joi.object({
  host: Joi.string()
    .valid(FEDERATION_HOSTS.CDP, FEDERATION_HOSTS.AZURE)
    .required(),
  service: Joi.when('host', {
    is: FEDERATION_HOSTS.CDP,
    then: service.required(),
    otherwise: Joi.forbidden()
  }),
  principalId: Joi.when('host', {
    is: FEDERATION_HOSTS.AZURE,
    then: principalId.required(),
    otherwise: Joi.forbidden()
  }),
  name: Joi.when('host', {
    is: FEDERATION_HOSTS.AZURE,
    then: applicationName.required(),
    otherwise: Joi.forbidden()
  }),
  environments: Joi.array()
    .items(environmentName)
    .min(1)
    .max(MAX_ENVIRONMENTS)
    .unique()
    .required()
}).unknown(false)

// What a change asks: a CDP application's service, or an Azure one's
// principal ID and name.
const federationChange = Joi.alternatives().try(
  Joi.object({ service: service.required() }).unknown(false),
  Joi.object({
    principalId: principalId.required(),
    name: applicationName.required()
  }).unknown(false)
)

const teamParams = Joi.object({ teamId: Joi.string().required() }).unknown(
  false
)
const applicationParams = Joi.object({
  teamId: Joi.string().required(),
  environment: environmentName.required(),
  federationId: Joi.string().required()
}).unknown(false)
const keyHeaders = Joi.object({
  'idempotency-key': Joi.string().guid({ version: 'uuidv4' }).required()
}).unknown(true)

function traceOf(request) {
  return {
    traceParent: request.headers.traceparent,
    cdpRequestId: request.headers['x-cdp-request-id']
  }
}

export const teamFederations = [
  {
    method: 'POST',
    path: '/v1/teams/{teamId}/federations/check',
    options: {
      app: { access: ACCESS.teamMember },
      description: `A dry run of federating an application: for each environment asked for, null or the code it would be refused with. Any member; changes nothing.`,
      validate: { params: teamParams, payload: federationRequest }
    },
    handler: async (request, h) =>
      h.response(
        await checkFederation(request.db, {
          teamId: request.params.teamId,
          request: request.payload,
          actor: request.auth.credentials
        })
      )
  },
  {
    method: 'POST',
    path: '/v1/teams/{teamId}/federations',
    options: {
      app: { access: ACCESS.teamMember },
      description: `Federates a CDP service or an Azure managed identity in each environment asked for (any member): one operation per environment, at most ${MAX_FEDERATIONS} applications in each. 202 with the applications; 200 when the Idempotency-Key was used already; 409 federation-refused names each environment refused, and then nothing is queued.`,
      validate: {
        headers: keyHeaders,
        params: teamParams,
        payload: federationRequest
      }
    },
    handler: async (request, h) => {
      const { federations, refused, replay } = await requestFederations(
        request.db,
        request.locker,
        {
          teamId: request.params.teamId,
          request: request.payload,
          actor: request.auth.credentials,
          idempotencyKey: request.headers['idempotency-key'],
          ...traceOf(request)
        },
        { operations: request.operations }
      )

      return h
        .response({ federations, ...(refused ? { refused } : {}) })
        .code(replay ? statusCodes.ok : statusCodes.accepted)
    }
  },
  {
    method: 'PATCH',
    path: '/v1/teams/{teamId}/environments/{environment}/federations/{federationId}',
    options: {
      app: { access: ACCESS.teamAdmin },
      description:
        "Changes an application (team admin): a CDP application's service, or an Azure one's principal ID and name. 202 with the application and its operation; 200 for a replayed Idempotency-Key.",
      validate: {
        headers: keyHeaders,
        params: applicationParams,
        payload: federationChange
      }
    },
    handler: async (request, h) => {
      const { federation, operationId, replay } = await changeFederation(
        request.db,
        request.locker,
        {
          ...request.params,
          request: request.payload,
          actor: request.auth.credentials,
          idempotencyKey: request.headers['idempotency-key'],
          ...traceOf(request)
        },
        { operations: request.operations }
      )

      return h
        .response({ federation, operationId })
        .code(replay ? statusCodes.ok : statusCodes.accepted)
    }
  },
  {
    method: 'DELETE',
    path: '/v1/teams/{teamId}/environments/{environment}/federations/{federationId}',
    options: {
      app: { access: ACCESS.teamAdmin },
      description:
        "Removes an application (team admin): the environment's team file is submitted without it. 202 while it is being removed, 200 once removed.",
      validate: { params: applicationParams }
    },
    handler: async (request, h) => {
      const { federation, done } = await removeFederation(
        request.db,
        request.locker,
        {
          ...request.params,
          actor: request.auth.credentials,
          ...traceOf(request)
        },
        { operations: request.operations }
      )

      return h
        .response({ federation })
        .code(done ? statusCodes.ok : statusCodes.accepted)
    }
  }
]
