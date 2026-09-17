import Joi from 'joi'

import { issueCredential } from '#/services/credential-service.js'

export const credentials = {
  method: 'POST',
  path: '/v1/credentials',
  options: {
    validate: {
      headers: Joi.object({
        'x-user-id': Joi.string().required(),
        'idempotency-key': Joi.string().guid({ version: 'uuidv4' }).required()
      }).unknown(true),
      payload: Joi.object({
        modelSlug: Joi.string()
          .pattern(/^[a-z0-9-]+$/)
          .required(),
        tier: Joi.string().valid('research').default('research')
      }).unknown(false)
    }
  },
  handler: async (request, h) => {
    const userId = request.headers['x-user-id']
    const idempotencyKey = request.headers['idempotency-key']
    const { modelSlug } = request.payload

    const { credential, secret, replay } = await issueCredential(request.db, {
      userId,
      modelSlug,
      idempotencyKey
    })

    const response = h.response({ credential, secret })

    if (!replay) {
      response.header('Location', `/v1/credentials/${credential._id}`)
    }

    return response.code(replay ? 200 : 201)
  }
}
