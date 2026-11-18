import Joi from 'joi'

import { statusCodes } from '#/common/constants/status-codes.js'
import { ACCESS } from '#/common/helpers/auth/access.js'
import { environmentName } from '#/common/helpers/environment-name.js'
import { addTeamClientSecret } from '#/services/team-client-secret-service.js'

const MAX_NAME_LENGTH = 30

// A short name for telling secrets apart. For an Entra registration it is the
// `displayName` of the Graph passwordCredential, whose limit Microsoft does not
// document, so it stays well within it: trimmed, 1 to 30 characters, plain
// characters only. Not unique.
const clientSecretName = Joi.string()
  .trim()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .pattern(/^[A-Za-z0-9 _.-]+$/)

export const teamClientSecrets = [
  {
    method: 'POST',
    path: '/v1/teams/{teamId}/environments/{environment}/client-secrets',
    options: {
      app: { access: ACCESS.teamAdmin },
      description:
        "Adds a client secret to the team's registration in one environment (team admin), with an optional short name (1 to 30 characters: letters, numbers, spaces, hyphens, underscores and full stops) to tell secrets apart: it expires in 90 days, is shown once with no-store and the team holds at most three that have not expired. 201 with the credential and the secret and a Location header of the credential (/v1/credentials/{id}); 200 with the credential only, and no Location, for a replayed Idempotency-Key. Only where client secrets are allowed (409 client-secrets-not-allowed), and not while a Platform Admin has disabled the team's credentials there (409 credentials-disabled).",
      validate: {
        headers: Joi.object({
          'idempotency-key': Joi.string().guid({ version: 'uuidv4' }).required()
        }).unknown(true),
        params: Joi.object({
          teamId: Joi.string().required(),
          environment: environmentName.required()
        }).unknown(false),
        payload: Joi.object({ name: clientSecretName.optional() })
          .unknown(false)
          .allow(null)
          .optional()
      }
    },
    handler: async (request, h) => {
      const { teamId, environment } = request.params

      const { credential, secret, replay } = await addTeamClientSecret(
        request.db,
        request.locker,
        {
          teamId,
          environment,
          name: request.payload?.name,
          actor: request.auth.credentials,
          idempotencyKey: request.headers['idempotency-key']
        }
      )

      const response = h
        .response(replay ? { credential } : { credential, secret })
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')

      // The secret is a credential: it is read, rotated and revoked at
      // /v1/credentials/{id}, as one issued for a model is.
      if (!replay) {
        response.header('Location', `/v1/credentials/${credential.id}`)
      }

      return response.code(replay ? statusCodes.ok : statusCodes.created)
    }
  }
]
