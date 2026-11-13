import Boom from '@hapi/boom'

import { ACCESS, isPlatformAdmin } from '#/common/helpers/auth/access.js'
import { boomWithCode } from '#/common/helpers/boom-with-code.js'
import { upsertUser, findCurrentUser } from '#/services/user-service.js'

const MAX_DISPLAY_NAME_LENGTH = 100

export const users = [
  {
    // Sign-in records the person from the validated token's claims and
    // nothing the caller sends: the body, if any, is never read.
    method: 'PUT',
    path: '/v1/users/me',
    options: {
      app: { access: ACCESS.signIn },
      payload: { parse: false }
    },
    handler: async (request, h) => {
      const { oid, tid, email, name } = request.auth.credentials

      if (!email || !name) {
        throw boomWithCode(
          Boom.unauthorized,
          'The token has no email or name claim',
          'invalid-token'
        )
      }

      const { user, team } = await upsertUser(request.db, {
        oid,
        tid,
        email,
        displayName: name.slice(0, MAX_DISPLAY_NAME_LENGTH),
        actor: request.auth.credentials
      })

      return h.response({
        user,
        team,
        isPlatformAdmin: isPlatformAdmin(request.auth.credentials)
      })
    }
  },
  {
    method: 'GET',
    path: '/v1/users/me',
    options: { app: { access: ACCESS.user } },
    handler: async (request, h) => {
      const result = await findCurrentUser(
        request.db,
        request.auth.credentials.userId
      )

      if (!result) {
        return Boom.notFound()
      }

      return h.response({
        ...result,
        isPlatformAdmin: isPlatformAdmin(request.auth.credentials)
      })
    }
  }
]
