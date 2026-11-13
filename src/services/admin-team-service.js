import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { escapeRegex } from '#/common/helpers/escape-regex.js'
import { requirePlatformAdmin } from '#/common/helpers/auth/access.js'
import { tenantOrchestratorRegistry } from '#/adapters/tenant-orchestrator-registry.js'
import {
  normaliseName,
  readTeamFiles,
  resolveTeamId,
  withMemberDisplayNames
} from '#/services/team-service.js'
import { TEAM_STATUS, statusOf } from '#/services/team-status.js'

/** Teams on a page of the Platform Admin Teams list (design F). */
export const ADMIN_TEAMS_PAGE_SIZE = 25

/**
 * The Platform Admin's view of a team that does not exist. The caller has
 * already been shown to hold the right, so there is nothing to hide.
 */
function teamNotFound() {
  return boomWithCode(
    Boom.notFound,
    'There is no team with this id',
    'team-not-found'
  )
}

/**
 * The team a Platform Admin names by id or slug. The right is checked first
 * and audited, so a person without it learns nothing about which teams exist;
 * a team nobody holds is `404 team-not-found`.
 * @param {import('mongodb').Db} db
 * @param {object} actor - the token's credentials
 * @param {string} idOrSlug
 * @returns {Promise<object>} the `teams` document
 */
export async function requireTeamForPlatformAdmin(db, actor, idOrSlug) {
  await requirePlatformAdmin(db, actor, {
    resource: 'team',
    resourceId: idOrSlug
  })

  const teamId = await resolveTeamId(db, idOrSlug)
  const team = teamId
    ? await db.collection('teams').findOne({ _id: new ObjectId(teamId) })
    : null

  if (!team) {
    throw teamNotFound()
  }

  return team
}

// A team with no status is active, so the active filter also takes it.
function statusFilter(status) {
  return status === TEAM_STATUS.active
    ? { $in: [TEAM_STATUS.active, null] }
    : status
}

function listFilter({ search, status }) {
  return {
    ...(search && {
      normalisedName: { $regex: escapeRegex(normaliseName(search)) }
    }),
    ...(status && { status: statusFilter(status) })
  }
}

function environmentRank(environment) {
  const rank = config.get('teamDeployment.environments').indexOf(environment)

  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank
}

// The environments each team has a deployment record in, in the configured
// order, then by name for any the instance no longer lists.
async function environmentsByTeam(db, teamIds) {
  const rows = await db
    .collection('teamDeployments')
    .find(
      { teamId: { $in: teamIds } },
      { projection: { teamId: 1, environment: 1 } }
    )
    .toArray()
  const byTeam = new Map(teamIds.map((teamId) => [teamId, []]))

  for (const { teamId, environment } of rows) {
    byTeam.get(teamId).push(environment)
  }

  for (const environments of byTeam.values()) {
    environments.sort(
      (a, b) => environmentRank(a) - environmentRank(b) || a.localeCompare(b)
    )
  }

  return byTeam
}

async function memberCounts(db, teamIds) {
  const counts = await db
    .collection('teamMembers')
    .aggregate([
      { $match: { teamId: { $in: teamIds }, status: 'active' } },
      { $group: { _id: '$teamId', count: { $sum: 1 } } }
    ])
    .toArray()

  return new Map(counts.map(({ _id, count }) => [_id, count]))
}

/**
 * One page of every team for a Platform Admin, sorted by name: its status,
 * the environments it has deployment records in and its active member count.
 * `search` matches part of the name as the team's name is normalised (case
 * and spaces do not matter) and is matched literally, never as a pattern.
 * @param {import('mongodb').Db} db
 * @param {{actor: object, search?: string, status?: string, page?: number}} params - `actor` is the token's credentials
 * @returns {Promise<{teams: object[], page: number, pageSize: number, total: number}>}
 */
export async function listAdminTeams(db, { actor, search, status, page = 1 }) {
  await requirePlatformAdmin(db, actor)

  const filter = listFilter({ search, status })
  const teams = db.collection('teams')
  const [found, total] = await Promise.all([
    teams
      .find(filter)
      .sort({ normalisedName: 1, _id: 1 })
      .skip((page - 1) * ADMIN_TEAMS_PAGE_SIZE)
      .limit(ADMIN_TEAMS_PAGE_SIZE)
      .toArray(),
    teams.countDocuments(filter)
  ])
  const teamIds = found.map((team) => team._id.toString())
  const [environments, counts] = await Promise.all([
    environmentsByTeam(db, teamIds),
    memberCounts(db, teamIds)
  ])

  return {
    teams: found.map((team) => {
      const id = team._id.toString()

      return {
        id,
        name: team.name,
        slug: team.slug,
        status: statusOf(team),
        environments: environments.get(id),
        memberCount: counts.get(id) ?? 0
      }
    }),
    page,
    pageSize: ADMIN_TEAMS_PAGE_SIZE,
    total
  }
}

function environmentOf({ environment, document }) {
  return {
    environment,
    fileStatus: document.status ?? null,
    ...(document.removeAfter && { removeAfter: document.removeAfter })
  }
}

/**
 * One team for a Platform Admin, whatever its status and whether or not they
 * belong to it: the team, each environment's team file status and removal
 * date as `main` holds them, and the active members as the team's own page
 * shows them. A failed read of the files is `502 upstream-unavailable`, not
 * an empty list.
 * @param {import('mongodb').Db} db
 * @param {{id: string, actor: object}} params - `id` is the team's id or slug
 * @param {{registry?: import('#/adapters/tenant-orchestrator-registry.js').TenantOrchestratorRegistry}} [deps]
 */
export async function findAdminTeam(
  db,
  { id, actor },
  { registry = tenantOrchestratorRegistry } = {}
) {
  const team = await requireTeamForPlatformAdmin(db, actor, id)
  const teamId = team._id.toString()
  const [members, files] = await Promise.all([
    db.collection('teamMembers').find({ teamId, status: 'active' }).toArray(),
    readTeamFiles(registry, team.slug)
  ])

  return {
    team: {
      id: teamId,
      name: team.name,
      slug: team.slug,
      serviceCode: team.serviceCode,
      status: statusOf(team),
      environments: files.map(environmentOf)
    },
    members: await withMemberDisplayNames(db, members)
  }
}
