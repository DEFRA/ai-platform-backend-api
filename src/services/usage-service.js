import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import { boomWithCode, Boom } from '#/common/helpers/boom-with-code.js'
import { requirePlatformAdmin } from '#/common/helpers/auth/access.js'
import { isReservedApiSlug } from '#/common/helpers/reserved-api-slugs.js'
import { USAGE_NOT_AVAILABLE } from '#/adapters/usage-reader.js'
import { usageReaderRegistry } from '#/adapters/usage-reader-registry.js'
import {
  findMemberTeam,
  requireAvailableEnvironment
} from '#/services/team-environments-service.js'
import { teamEnvironments } from '#/services/team-deployment-service.js'
import {
  MODEL_PRICES,
  PRICE_CURRENCY,
  PRICE_VERSION
} from '#/services/model-prices.js'
import { summariseUsage, usagePeriod } from '#/services/usage-summary.js'
import { overviewOf, monthsWindow } from '#/services/usage-overview.js'
import { MODEL_CARBON } from '#/services/model-carbon.js'
import { findOwnCredential } from '#/services/credential-access.js'
import {
  environmentOf,
  externalGatewaySubscriptionIdOf
} from '#/services/credential-common.js'

// Every figure is an estimate until the tariff and period are agreed (B19), and
// says which prices it used.
const UPSTREAM_UNAVAILABLE = 'upstream-unavailable'
const UPSTREAM_UNAVAILABLE_MESSAGE = 'Usage could not be read just now'
const MS_PER_DAY = 86_400_000

function upstreamUnavailable() {
  return boomWithCode(
    Boom.badGateway,
    UPSTREAM_UNAVAILABLE_MESSAGE,
    UPSTREAM_UNAVAILABLE
  )
}

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

    throw upstreamUnavailable()
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

  // A team that holds the id of a gateway API no team owns (the Research
  // tier's) must not read that API's usage as its own.
  if (isReservedApiSlug(team.slug)) {
    throw boomWithCode(
      Boom.notFound,
      'Usage is not available for this team',
      USAGE_NOT_AVAILABLE
    )
  }

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
      .toArray(),
    readUsage(reader, { environment, from: period.from, to: period.to })
  ])
  const slugs = new Set(
    teams.map((team) => team.slug).filter((slug) => !isReservedApiSlug(slug))
  )
  const summarise = (slug, slugRows) =>
    summariseUsage(slugRows, { period, teamSlug: slug, prices })
  // Grouped once, so a team's rows are a lookup and not a scan of every row.
  const rowsBySlug = new Map()

  for (const row of rows) {
    const group = rowsBySlug.get(row.teamSlug)

    if (group) {
      group.push(row)
    } else {
      rowsBySlug.set(row.teamSlug, [row])
    }
  }

  const rowsOf = (slug) => rowsBySlug.get(slug) ?? []

  const teamsView = teams
    .map((team) => {
      // A team holding a reserved API id owns none of that API's usage.
      const owned = slugs.has(team.slug) ? rowsOf(team.slug) : []
      const { totals } = summarise(team.slug, owned)

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

const OVERVIEW_MONTHS = 6
const REFUSAL_DAYS = 7
const OVERVIEW_CACHE_MS = 60_000
const overviewCache = new Map()

function carbonRules() {
  return { enabled: config.get('usage.carbonEnabled'), factors: MODEL_CARBON }
}

function dayBefore(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10)
}

function laterDay(first, second) {
  return new Date(Math.max(Date.parse(first), Date.parse(second)))
    .toISOString()
    .slice(0, 10)
}

// One environment's rows and refused calls, or `null` when it has no usage
// source. Any other failure is a failed read: nothing partial is shown.
async function readEnvironment(reader, { environment, window, teamSlug }) {
  try {
    const refusalFrom = laterDay(
      dayBefore(window.to, REFUSAL_DAYS),
      window.from
    )

    const [rows, refusals] = await Promise.all([
      reader.readUsage({
        environment,
        from: window.from,
        to: window.to,
        teamSlug
      }),
      reader.readRefusals({
        environment,
        from: refusalFrom,
        to: window.to,
        teamSlug
      })
    ])

    return { environment, rows, refusals }
  } catch (error) {
    if (error?.code === USAGE_NOT_AVAILABLE) {
      return null
    }

    throw upstreamUnavailable()
  }
}

async function overviewOfTeam(team, { reader, now, prices }) {
  const window = monthsWindow(now, OVERVIEW_MONTHS)
  const environments = teamEnvironments()
  const reads = await Promise.all(
    environments.map((environment) =>
      readEnvironment(reader, { environment, window, teamSlug: team.slug })
    )
  )
  const read = reads.filter(Boolean)

  if (read.length === 0) {
    throw boomWithCode(
      Boom.notFound,
      'Usage is not available for this team yet',
      USAGE_NOT_AVAILABLE
    )
  }

  return {
    teamId: team.teamId,
    teamName: team.name,
    teamSlug: team.slug,
    source: reader.source,
    costBasis: costBasisOf(),
    ...overviewOf(
      Object.fromEntries(
        read.map(({ environment, rows }) => [environment, rows])
      ),
      {
        now,
        months: OVERVIEW_MONTHS,
        teamSlug: team.slug,
        prices,
        carbon: carbonRules(),
        unavailable: environments.filter(
          (environment) => !read.some((one) => one.environment === environment)
        ),
        refusals: read.map(({ environment, refusals }) => ({
          environment,
          days: refusals
        }))
      }
    )
  }
}

// Home and the Usage pages ask for the same team within a minute; the answer
// is for one team, so the cache key is the team and the month.
function cachedOverview(team, deps) {
  const key = `${team.teamId}:${deps.reader.source}:${isoDay(deps.now)}`
  const hit = overviewCache.get(key)

  if (hit && deps.now.getTime() - hit.at < OVERVIEW_CACHE_MS) {
    return hit.value
  }

  const value = overviewOfTeam(team, deps).catch((error) => {
    overviewCache.delete(key)

    throw error
  })

  overviewCache.set(key, { at: deps.now.getTime(), value })

  return value
}

function isoDay(date) {
  return date.toISOString().slice(0, 10)
}

/**
 * Forgets every cached overview (tests, and a change of source).
 */
export function clearUsageOverviewCache() {
  overviewCache.clear()
}

/**
 * A team's usage across every environment this instance offers over the last
 * six months: a figure for each month, and for this month the totals, a
 * forecast, the shares by environment and model, the tokens of each day and
 * what needs attention. Any member of the team; a non-member gets `404`, and
 * the query names the actor's own team only.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, actor: {userId: string}}} params
 * @param {{reader?: import('#/adapters/usage-reader.js').UsageReader, now?: () => Date, prices?: typeof MODEL_PRICES}} [deps]
 */
export async function getTeamUsageOverview(
  db,
  { teamId, actor },
  {
    reader = usageReaderRegistry.current,
    now = () => new Date(),
    prices = MODEL_PRICES
  } = {}
) {
  const { teamId: id, team } = await findMemberTeam(db, teamId, actor)

  if (isReservedApiSlug(team.slug)) {
    throw boomWithCode(
      Boom.notFound,
      'Usage is not available for this team',
      USAGE_NOT_AVAILABLE
    )
  }

  return cachedOverview(
    { teamId: id, slug: team.slug, name: team.name },
    { reader, now: now(), prices }
  )
}

/**
 * What Home shows of usage: for each team the person belongs to, this month's
 * tokens, estimated cost and forecast, and what needs attention. A team whose
 * usage cannot be read is listed with the reason, not left out.
 * @param {import('mongodb').Db} db
 * @param {{actor: {userId: string}}} params
 * @param {{reader?: import('#/adapters/usage-reader.js').UsageReader, now?: () => Date, prices?: typeof MODEL_PRICES}} [deps]
 */
export async function getUserUsageSummary(
  db,
  { actor },
  {
    reader = usageReaderRegistry.current,
    now = () => new Date(),
    prices = MODEL_PRICES
  } = {}
) {
  const memberships = await db
    .collection('teamMembers')
    .find({ userId: actor.userId, status: 'active' })
    .toArray()
  const teams = await db
    .collection('teams')
    .find(
      {
        _id: { $in: memberships.map((member) => new ObjectId(member.teamId)) }
      },
      { projection: { slug: 1, name: 1 } }
    )
    .toArray()
  const at = now()

  const items = await Promise.all(
    teams
      .filter((team) => !isReservedApiSlug(team.slug))
      .map(async (team) => {
        const base = {
          teamId: team._id.toString(),
          slug: team.slug,
          name: team.name
        }

        try {
          const overview = await cachedOverview(base, {
            reader,
            now: at,
            prices
          })

          return {
            ...base,
            available: true,
            month: overview.month,
            totals: overview.current.totals,
            forecast: overview.current.forecast,
            attention: overview.attention,
            carbonBasis: overview.carbonBasis,
            costBasis: overview.costBasis,
            source: overview.source
          }
        } catch (error) {
          return {
            ...base,
            available: false,
            reason: error?.data?.code ?? UPSTREAM_UNAVAILABLE
          }
        }
      })
  )

  return {
    items: items.toSorted((a, b) => a.name.localeCompare(b.name))
  }
}

/**
 * A personal (Research tier) key's usage over the last `days` days, for the
 * person who owns it, and when it ends. Counts only. Someone else's key is a
 * refused 404, audited.
 * @param {import('mongodb').Db} db
 * @param {{id: string, days: number, actor: {userId: string}}} params
 * @param {{reader?: import('#/adapters/usage-reader.js').UsageReader, now?: () => Date, prices?: typeof MODEL_PRICES}} [deps]
 */
export async function getKeyUsage(
  db,
  { id, days, actor },
  {
    reader = usageReaderRegistry.current,
    now = () => new Date(),
    prices = MODEL_PRICES
  } = {}
) {
  const credential = await findOwnCredential(db, { id, actor })

  if (credential?.tier !== 'research') {
    throw boomWithCode(Boom.notFound, 'No such key', 'credential-not-found')
  }

  const environment = environmentOf(credential)
  const subscriptionId = externalGatewaySubscriptionIdOf(credential)
  const period = usagePeriod(now(), days)
  const rows = await readUsage(reader, {
    environment,
    from: period.from,
    to: period.to,
    subscriptionId
  })

  return {
    credentialId: id,
    environment,
    source: reader.source,
    period,
    costBasis: costBasisOf(),
    key: {
      expiresAt: credential.expiresAt ?? null,
      renewalsUsed: credential.renewalCount ?? 0,
      renewalCap: config.get('research.renewalCap'),
      validDays: config.get('research.credentialTtlDays')
    },
    ...summariseUsage(rows, { period, teamSlug: 'research', prices })
  }
}
