import { ACCESS } from '#/common/helpers/auth/access.js'

// CDP's probe: no token.
export const health = {
  method: 'GET',
  path: '/health',
  options: { auth: false, app: { access: ACCESS.public } },
  handler: (_request, h) => h.response({ status: 'ok' })
}
