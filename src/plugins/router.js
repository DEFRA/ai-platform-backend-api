import { health } from '#/routes/health.js'
import { example } from '#/routes/example.js'
import { models } from '#/routes/models.js'
import { users } from '#/routes/users.js'
import { credentials } from '#/routes/credentials.js'
import { teams } from '#/routes/teams.js'
import { teamDeployments } from '#/routes/team-deployments.js'
import { maintenance } from '#/routes/maintenance.js'

export const router = {
  plugin: {
    name: 'router',
    register: (server, _options) => {
      server.route(
        [health, maintenance].concat(
          example,
          models,
          users,
          credentials,
          teams,
          teamDeployments
        )
      )
    }
  }
}
