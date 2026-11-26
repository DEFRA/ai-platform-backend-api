import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { requirePlatformAdmin } from '#/common/helpers/auth/access.js'
import { USAGE_NOT_AVAILABLE } from '#/adapters/usage-reader.js'
import { usageReaderRegistry } from '#/adapters/usage-reader-registry.js'
import {
  findMemberTeam,
  requireAvailableEnvironment
} from '#/services/team-environments-service.js'
import {
  MODEL_PRICES,
  PRICE_CURRENCY,
  PRICE_VERSION
} from '#/services/model-prices.js'
import { summariseUsage, usagePeriod } from '#/services/usage-summary.js'

const MAX_TEAMS = 1000

// Every figure is an estimate until the tariff and period are agreed (B19), and
// says which prices it used.
function costBasisOf() {
  return {
    estimate: true,
    currency: PRICE_CURRENCY,
    priceVersion: PRICE_VERSION
  }
}

async function readUsage(reader, query) {
  try {
    return await reader.readUsage(query)
  } catch (error) {
    if (error?.code === USAGE_NOT_AVAILABLE) {
      throw boomWithCode(
        Boom.notFound,
        'Usage is not available for this environment yet',
        USAGE_NOT_AVAILABLE
      )
    }

    throw boomWithCode(
      Boom.badGateway,
      'Usage could not be read just now',
      'upstream-unavailable'
    )
  }
}

/**
 * One team's usage in an environment over the last `days` days: totals, a
 * figure for every day and one for each model, with an estimated cost. Any
 * member of the team; a non-member gets `404` and another team's usage is
 * never asked for, because the query names the actor's own team.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string, days: number, actor: {userId: string}}} params
 * @param {{reader?: import('#/adapters/usage-reader.js').UsageReader, now?: () => Date, prices?: typeof MODEL_PRICES}} [deps]
 */
export async function getTeamUsage(
  db,
  { teamId, environment, days, actor },
  {
    reader = usageReaderRegistry.current,
    now = () => new Date(),
    prices = MODEL_PRICES
  } = {}
) {
  requireAvailableEnvironment(environment)

  const { teamId: id, team } = await findMemberTeam(db, teamId, actor)
  const period = usagePeriod(now(), days)
  const rows = await readUsage(reader, {
    environment,
    from: period.from,
    to: period.to,
    teamSlug: team.slug
  })

  return {
    teamId: id,
    environment,
    source: reader.source,
    period,
    costBasis: costBasisOf(),
    ...summariseUsage(rows, { period, teamSlug: team.slug, prices })
  }
}

/**
 * Every team's usage in an environment over the last `days` days, for a
 * Platform Admin: a row per team (those that made no calls included), and the
 * gateway APIs no team owns, such as the Research tier's. Anyone else is
 * refused and audited before anything is read.
 * @param {import('mongodb').Db} db
 * @param {{environment: string, days: number, actor: {isPlatformAdmin?: boolean}}} params
 * @param {{reader?: import('#/adapters/usage-reader.js').UsageReader, now?: () => Date, prices?: typeof MODEL_PRICES}} [deps]
 */
export async function getAdminUsage(
  db,
  { environment, days, actor },
  {
    reader = usageReaderRegistry.current,
    now = () => new Date(),
    prices = MODEL_PRICES
  } = {}
) {
  await requirePlatformAdmin(db, actor)
  requireAvailableEnvironment(environment)

  const period = usagePeriod(now(), days)
  const [teams, rows] = await Promise.all([
    db
      .collection('teams')
      .find({}, { projection: { slug: 1, name: 1, serviceCode: 1 } })
      .limit(MAX_TEAMS)
      .toArray(),
    readUsage(reader, { environment, from: period.from, to: period.to })
  ])
  const slugs = new Set(teams.map((team) => team.slug))
  const summarise = (slug, slugRows) =>
    summariseUsage(slugRows, { period, teamSlug: slug, prices })
  const rowsOf = (slug) => rows.filter((row) => row.teamSlug === slug)

  const teamsView = teams
    .map((team) => {
      const { totals } = summarise(team.slug, rowsOf(team.slug))

      return {
        teamId: team._id.toString(),
        slug: team.slug,
        name: team.name,
        serviceCode: team.serviceCode ?? null,
        ...totals
      }
    })
    .sort(
      (a, b) => b.totalTokens - a.totalTokens || a.slug.localeCompare(b.slug)
    )

  const otherApis = [...new Set(rows.map((row) => row.teamSlug))]
    .filter((slug) => !slugs.has(slug))
    .map((slug) => ({ apiId: slug, ...summarise(slug, rowsOf(slug)).totals }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  return {
    environment,
    source: reader.source,
    period,
    costBasis: costBasisOf(),
    teams: teamsView,
    otherApis
  }
}
