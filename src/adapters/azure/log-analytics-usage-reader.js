import { createArmClient } from '#/adapters/azure/arm-client.js'
import { config } from '#/config.js'
import { usageNotAvailable } from '#/adapters/usage-reader.js'

const QUERY_API_VERSION = '2017-01-01-preview'
// The gateway log can land a little before or after the model's own record.
const CLOCK_SKEW = '1h'
const SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const SUBSCRIPTION_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_LENGTH = 10
const SUBSCRIPTION_ID = /^[0-9a-fA-F-]{36}$/
const RESOURCE_GROUP = /^[\w.()-]{1,90}$/
const APIM_NAME = /^[A-Za-z0-9-]{1,50}$/

function requireDate(value) {
  const parsed = ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null

  if (
    !parsed ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, DAY_LENGTH) !== value
  ) {
    throw new Error('Usage dates must be real YYYY-MM-DD dates')
  }

  return value
}

// Log Analytics takes no query parameters here, so everything that reaches the
// text is checked first: a slug, a date or an API Management resource ID built
// from checked parts, nothing else. Two instances may log to one workspace, so
// both tables are limited to this environment's own API Management.
function queryOf({ from, to, teamSlug, subscriptionId, resourceId }) {
  const team = teamSlug === undefined ? '' : `| where ApiId == '${teamSlug}'`
  const key =
    subscriptionId === undefined
      ? ''
      : `| where ApimSubscriptionId == '${subscriptionId}'`

  return `let calls = ApiManagementGatewayLogs
| where TimeGenerated >= datetime(${from}) - ${CLOCK_SKEW} and TimeGenerated < datetime(${to}) + ${CLOCK_SKEW}
| where _ResourceId =~ '${resourceId}'
${team}
${key}
| where isnotempty(ApiId)
| project CorrelationId = tostring(CorrelationId), ApiId;
ApiManagementGatewayLlmLog
| where TimeGenerated >= datetime(${from}) and TimeGenerated < datetime(${to})
| where _ResourceId =~ '${resourceId}'
| summarize PromptTokens = max(PromptTokens), CompletionTokens = max(CompletionTokens), DeploymentName = take_any(DeploymentName), Day = min(startofday(TimeGenerated)) by CorrelationId
| join kind=inner calls on CorrelationId
| summarize Requests = count(), PromptTokens = sum(PromptTokens), CompletionTokens = sum(CompletionTokens) by Day, ApiId, DeploymentName
| order by Day asc, ApiId asc, DeploymentName asc`
}

// Calls the team's API refused with 429, a day at a time: the gateway's own
// answer to a caller over its limit.
function refusalsQueryOf({ from, to, teamSlug, resourceId }) {
  return `ApiManagementGatewayLogs
| where TimeGenerated >= datetime(${from}) and TimeGenerated < datetime(${to})
| where _ResourceId =~ '${resourceId}'
| where ApiId == '${teamSlug}'
| where ResponseCode == 429
| summarize Refused = count() by Day = startofday(TimeGenerated)
| order by Day asc`
}

// The resource ID the gateway logs carry for this environment's API Management,
// in the lower case Azure Monitor writes it (compared without case anyway).
function apimResourceIdOf(target) {
  if (
    !SUBSCRIPTION_ID.test(target.subscriptionId ?? '') ||
    !RESOURCE_GROUP.test(target.resourceGroup ?? '') ||
    !APIM_NAME.test(target.apimName ?? '')
  ) {
    throw usageNotAvailable('The environment has no valid API Management name')
  }

  return `/subscriptions/${target.subscriptionId}/resourcegroups/${target.resourceGroup}/providers/microsoft.apimanagement/service/${target.apimName}`.toLowerCase()
}

// Log Analytics may answer 200 with some tables missing and an `error` beside
// them (`PartialError`); totals from that would understate usage and cost.
function requireComplete(body) {
  if (body?.error ?? body?.Error) {
    throw new Error('Log Analytics returned a partial or failed result')
  }
}

// ARM answers `Tables`/`Columns`/`Rows` on this API version; accept the
// camel-case shape too so a change of version does not blank every page.
function rowsOf(body) {
  const table = (body?.Tables ?? body?.tables)?.[0]
  const columns = (table?.Columns ?? table?.columns ?? []).map(
    (column) => column.ColumnName ?? column.name
  )

  return (table?.Rows ?? table?.rows ?? []).map((cells) =>
    Object.fromEntries(columns.map((name, index) => [name, cells[index]]))
  )
}

function usageRowOf(row) {
  return {
    day: String(row.Day).slice(0, DAY_LENGTH),
    teamSlug: row.ApiId,
    deployment: row.DeploymentName,
    requests: Number(row.Requests),
    promptTokens: Number(row.PromptTokens),
    completionTokens: Number(row.CompletionTokens)
  }
}

/**
 * Reads what the gateway recorded from each environment's Log Analytics
 * workspace: the LLM log's token counts joined, by correlation ID, to the
 * gateway log's API (the team's path). One query through the ARM endpoint, so
 * it uses the same identity and egress as every other Azure call. It selects
 * counts only and never a message, caller address or user.
 * @param {{armClient?: ReturnType<typeof createArmClient>, environments?: Record<string, {subscriptionId: string, resourceGroup: string, apimName: string, logAnalyticsWorkspace?: string}>}} [deps]
 * @returns {import('#/adapters/usage-reader.js').UsageReader}
 */
export function createLogAnalyticsUsageReader({
  armClient = createArmClient(),
  environments = config.get('aipEnvironments')
} = {}) {
  function requireWindow(from, to) {
    requireDate(from)
    requireDate(to)

    if (to <= from) {
      throw new Error('Usage window must end after it starts')
    }
  }

  function targetOf(environment) {
    const target = Object.hasOwn(environments, environment)
      ? environments[environment]
      : undefined

    if (!target?.logAnalyticsWorkspace) {
      throw usageNotAvailable(
        `No Log Analytics workspace is configured for "${environment}"`
      )
    }

    return target
  }

  async function run(target, query, signal) {
    const body = await armClient.request(
      'POST',
      `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.OperationalInsights/workspaces/${target.logAnalyticsWorkspace}/api/query?api-version=${QUERY_API_VERSION}`,
      { body: { query }, signal }
    )

    requireComplete(body)

    return rowsOf(body)
  }

  return {
    source: 'log-analytics',

    async readUsage({
      environment,
      from,
      to,
      teamSlug,
      subscriptionId,
      signal
    }) {
      requireWindow(from, to)

      if (teamSlug !== undefined && !SLUG.test(teamSlug)) {
        throw new Error('Usage team slug must be a slug')
      }

      if (
        subscriptionId !== undefined &&
        !SUBSCRIPTION_KEY.test(subscriptionId)
      ) {
        throw new Error('Usage subscription must be a subscription ID')
      }

      const target = targetOf(environment)
      const rows = await run(
        target,
        queryOf({
          from,
          to,
          teamSlug,
          subscriptionId,
          resourceId: apimResourceIdOf(target)
        }),
        signal
      )

      return rows.map(usageRowOf)
    },

    async readRefusals({ environment, from, to, teamSlug, signal }) {
      requireWindow(from, to)

      if (!SLUG.test(teamSlug ?? '')) {
        throw new Error('Usage team slug must be a slug')
      }

      const target = targetOf(environment)
      const rows = await run(
        target,
        refusalsQueryOf({
          from,
          to,
          teamSlug,
          resourceId: apimResourceIdOf(target)
        }),
        signal
      )

      return rows.map((row) => ({
        day: String(row.Day).slice(0, DAY_LENGTH),
        refused: Number(row.Refused)
      }))
    }
  }
}
