import { health } from '#/routes/health.js'
import { example } from '#/routes/example.js'
import { models } from '#/routes/models.js'
import { users } from '#/routes/users.js'
import { credentials } from '#/routes/credentials.js'

export const router = {
  plugin: {
    name: 'router',
    register: (server, _options) => {
      server.route([health, users, credentials].concat(example, models))
    }
  }
}
