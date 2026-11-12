import { health } from '#/routes/health.js'
import { models } from '#/routes/models.js'
import { users } from '#/routes/users.js'
import { credentials } from '#/routes/credentials.js'
import { teams } from '#/routes/teams.js'
import { teamDeployments } from '#/routes/team-deployments.js'
import { teamOperations } from '#/routes/team-operations.js'
import { teamEnvironments } from '#/routes/team-environments.js'
import { teamLimits } from '#/routes/team-limits.js'
import { adminTeamDeployments } from '#/routes/admin-team-deployments.js'
import { maintenance } from '#/routes/maintenance.js'

export const router = {
  plugin: {
    name: 'router',
    register: (server, _options) => {
      server.route(
        [health, maintenance].concat(
          models,
          users,
          credentials,
          teams,
          teamDeployments,
          teamOperations,
          teamEnvironments,
          teamLimits,
          adminTeamDeployments
        )
      )
    }
  }
}
