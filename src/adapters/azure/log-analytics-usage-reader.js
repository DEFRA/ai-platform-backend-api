import { createArmClient } from '#/adapters/azure/arm-client.js'
import { config } from '#/config.js'
import { usageNotAvailable } from '#/adapters/usage-reader.js'

const QUERY_API_VERSION = '2017-01-01-preview'
// The gateway log can land a little before or after the model's own record.
const CLOCK_SKEW = '1h'
const SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_LENGTH = 10

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
// text is checked first: a slug or a date, nothing else.
function queryOf({ from, to, teamSlug }) {
  const team = teamSlug === undefined ? '' : `| where ApiId == '${teamSlug}'`

  return `let calls = ApiManagementGatewayLogs
| where TimeGenerated >= datetime(${from}) - ${CLOCK_SKEW} and TimeGenerated < datetime(${to}) + ${CLOCK_SKEW}
${team}
| where isnotempty(ApiId)
| project CorrelationId = tostring(CorrelationId), ApiId;
ApiManagementGatewayLlmLog
| where TimeGenerated >= datetime(${from}) and TimeGenerated < datetime(${to})
| summarize PromptTokens = max(PromptTokens), CompletionTokens = max(CompletionTokens), DeploymentName = take_any(DeploymentName), Day = min(startofday(TimeGenerated)) by CorrelationId
| join kind=inner calls on CorrelationId
| summarize Requests = count(), PromptTokens = sum(PromptTokens), CompletionTokens = sum(CompletionTokens) by Day, ApiId, DeploymentName
| order by Day asc, ApiId asc, DeploymentName asc`
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
 * @param {{armClient?: ReturnType<typeof createArmClient>, environments?: Record<string, {subscriptionId: string, resourceGroup: string, logAnalyticsWorkspace?: string}>}} [deps]
 * @returns {import('#/adapters/usage-reader.js').UsageReader}
 */
export function createLogAnalyticsUsageReader({
  armClient = createArmClient(),
  environments = config.get('aipEnvironments')
} = {}) {
  return {
    source: 'log-analytics',

    async readUsage({ environment, from, to, teamSlug, signal }) {
      requireDate(from)
      requireDate(to)

      if (to <= from) {
        throw new Error('Usage window must end after it starts')
      }

      if (teamSlug !== undefined && !SLUG.test(teamSlug)) {
        throw new Error('Usage team slug must be a slug')
      }

      const target = Object.hasOwn(environments, environment)
        ? environments[environment]
        : undefined

      if (!target?.logAnalyticsWorkspace) {
        throw usageNotAvailable(
          `No Log Analytics workspace is configured for "${environment}"`
        )
      }

      const body = await armClient.request(
        'POST',
        `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.OperationalInsights/workspaces/${target.logAnalyticsWorkspace}/api/query?api-version=${QUERY_API_VERSION}`,
        { body: { query: queryOf({ from, to, teamSlug }) }, signal }
      )

      return rowsOf(body).map(usageRowOf)
    }
  }
}
