import { ecsFormat } from '@elastic/ecs-pino-format'
import { config } from '#/config.js'
import { getTraceId } from '@defra/hapi-tracing'

const logConfig = config.get('log')
const serviceName = config.get('serviceName')
const serviceVersion = config.get('serviceVersion')

const formatters = {
  ecs: {
    ...ecsFormat({
      serviceVersion,
      serviceName
    })
  },
  // No transport here - `hapi-pino`/`@defra/cdp-auditing` pull in their own
  // nested pino/thread-stream versions, and pino-pretty's worker-thread
  // transport crashes ("this should not happen: undefined") when more than
  // one thread-stream version is present in the tree. Pretty-printing is
  // applied by piping stdout through the pino-pretty CLI instead (see the
  // "dev"/"dev:debug" scripts), which never spawns a worker thread.
  'pino-pretty': {}
}

// What a Platform Admin types into the Teams and Audit log filters is a name,
// so it is never logged, whatever `LOG_REDACT` says: a request's `query` is
// logged in production, which the configured paths do not cover.
const PRIVATE_QUERY_PATHS = ['req.query.person', 'req.query.search']

export const loggerOptions = {
  enabled: logConfig.isEnabled,
  ignorePaths: ['/health'],
  redact: {
    paths: [...logConfig.redact, ...PRIVATE_QUERY_PATHS],
    remove: true
  },
  level: logConfig.level,
  ...formatters[logConfig.format],
  nesting: true,
  mixin() {
    const mixinValues = {}
    const traceId = getTraceId()
    if (traceId) {
      mixinValues.trace = { id: traceId }
    }
    return mixinValues
  }
}
