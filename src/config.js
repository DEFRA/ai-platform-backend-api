import convict from 'convict'
import convictFormatWithValidator from 'convict-format-with-validator'

import { convictValidateMongoUri } from '#/common/helpers/convict/validate-mongo-uri.js'
import { convictValidateAipEnvironments } from '#/common/helpers/convict/validate-aip-environments.js'
import { AZURE_APIM, DEFAULT_GATEWAY } from '#/adapters/gateway-keys.js'
import { gitopsConfigSchema } from '#/config-gitops.js'
import { githubConfigSchema } from '#/config-github.js'
import { portalAuthConfigSchema } from '#/config-portal-auth.js'

convict.addFormat(convictValidateMongoUri)
convict.addFormat(convictValidateAipEnvironments)
convict.addFormats(convictFormatWithValidator)

const isProduction = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'

const MAINTENANCE_INTERVAL_MINUTES = 5
const MS_PER_MINUTE = 60 * 1000

// Local-only fallback for armAuth.authMethod - no AWS STS to federate from outside CDP.
const ARM_AUTH_METHOD_CLIENT_SECRET = 'client-secret'

export const config = convict({
  serviceVersion: {
    doc: 'The service version, this variable is injected into your docker container in CDP environments',
    format: String,
    nullable: true,
    default: null,
    env: 'SERVICE_VERSION'
  },
  host: {
    doc: 'The IP address to bind',
    format: 'ipaddress',
    default: '0.0.0.0',
    env: 'HOST'
  },
  port: {
    doc: 'The port to bind',
    format: 'port',
    default: 3001,
    env: 'PORT'
  },
  serviceName: {
    doc: 'Api Service Name',
    format: String,
    default: 'ai-platform-backend-api'
  },
  cdpEnvironment: {
    doc: 'The CDP environment the app is running in. With the addition of "local" for local development',
    format: [
      'local',
      'infra-dev',
      'management',
      'dev',
      'test',
      'perf-test',
      'ext-test',
      'prod'
    ],
    default: 'local',
    env: 'ENVIRONMENT'
  },
  log: {
    isEnabled: {
      doc: 'Is logging enabled',
      format: Boolean,
      default: !isTest,
      env: 'LOG_ENABLED'
    },
    level: {
      doc: 'Logging level',
      format: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
      default: 'info',
      env: 'LOG_LEVEL'
    },
    format: {
      doc: 'Format to output logs in',
      format: ['ecs', 'pino-pretty'],
      default: isProduction ? 'ecs' : 'pino-pretty',
      env: 'LOG_FORMAT'
    },
    redact: {
      doc: 'Log paths to redact',
      format: Array,
      default: isProduction
        ? ['req.headers.authorization', 'req.headers.cookie', 'res.headers']
        : ['req', 'res', 'responseTime']
    }
  },
  mongo: {
    mongoUrl: {
      doc: 'URI for mongodb',
      format: String,
      default: 'mongodb://127.0.0.1:27017/',
      env: 'MONGO_URI'
    },
    databaseName: {
      doc: 'database for mongodb',
      format: String,
      default: 'ai-platform-backend-api',
      env: 'MONGO_DATABASE'
    },
    mongoOptions: {
      retryWrites: {
        doc: 'Enable Mongo write retries, overrides mongo URI when set.',
        format: Boolean,
        default: null,
        nullable: true,
        env: 'MONGO_RETRY_WRITES'
      },
      readPreference: {
        doc: 'Mongo read preference, overrides mongo URI when set.',
        format: [
          'primary',
          'primaryPreferred',
          'secondary',
          'secondaryPreferred',
          'nearest'
        ],
        default: null,
        nullable: true,
        env: 'MONGO_READ_PREFERENCE'
      }
    }
  },
  httpProxy: {
    doc: 'HTTP Proxy URL',
    format: String,
    nullable: true,
    default: null,
    env: 'HTTP_PROXY'
  },
  tracing: {
    header: {
      doc: 'CDP tracing header name',
      format: String,
      default: 'x-cdp-request-id',
      env: 'TRACING_HEADER'
    }
  },
  portalAuth: portalAuthConfigSchema,
  research: {
    environment: {
      doc: 'The AIP_ENVIRONMENTS entry research keys are issued into (subscription, API Management instance and tenants vault). Each credential records the environment it was issued in, so changing this never strands an existing key',
      format: String,
      default: 'infradev',
      env: 'RESEARCH_ENVIRONMENT'
    },
    credentialTtlDays: {
      doc: 'Research tier credential time-to-live in days',
      format: 'nat',
      default: 7,
      env: 'RESEARCH_CREDENTIAL_TTL_DAYS'
    },
    renewalCap: {
      doc: 'Maximum number of renewals allowed for a Research tier credential',
      format: 'nat',
      default: 3,
      env: 'RESEARCH_RENEWAL_CAP'
    },
    deploymentsCacheMs: {
      doc: 'How long in ms the models deployed in the research environment (read from its research.json on ai-platform-tenants) are cached, so listing models does not read GitHub per request. 0 turns the cache off',
      format: 'nat',
      default: 60000,
      env: 'RESEARCH_DEPLOYMENTS_CACHE_MS'
    }
  },
  teamDeployment: {
    environments: {
      doc: 'The environments a team may request a model deployment in, from this portal instance (design C #control-plane, D1): the CDP dev instance drives infradev, the test instance drives sandbox. Comma separated',
      format: Array,
      default: ['infradev'],
      env: 'TEAM_ENVIRONMENTS'
    },
    clientSecretEnvironments: {
      doc: 'The environments where a team may hold client secrets (design E choice A): the builder writes `secretsAllowed` in each team file from this list, true in these and false elsewhere. Comma separated. A QA secret needs a recorded exception for a host that cannot federate, which is not built, so QA is not listed',
      format: Array,
      default: ['infradev', 'sandbox', 'dev'],
      env: 'CLIENT_SECRET_ENVIRONMENTS'
    },
    mockStageDurationMs: {
      doc: 'Duration in ms of each mocked GitOps stage for team deployment provisioning',
      format: 'nat',
      default: 3000,
      env: 'TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS'
    },
    defaultTokensPerMinute: {
      doc: "Gateway token limit a new team file starts with, until B17 agrees per-environment bounds. An existing team file's limits are never overwritten",
      format: 'nat',
      default: 1000,
      env: 'TEAM_DEFAULT_TOKENS_PER_MINUTE'
    },
    defaultRequestsPerMinute: {
      doc: 'Gateway request limit a new team file starts with when the catalogue model states none',
      format: 'nat',
      default: 60,
      env: 'TEAM_DEFAULT_REQUESTS_PER_MINUTE'
    }
  },
  tenantOrchestrator: {
    doc: 'How team deployments reach the GitOps state repositories: mock stages events on a timer; sqs publishes commands to the GitOps worker and reads its events',
    format: ['mock', 'sqs'],
    default: 'mock',
    env: 'TENANT_ORCHESTRATOR'
  },
  directory: {
    mode: {
      doc: 'Where team Admins find people to add: mock searches seeded fictional people; graph searches the Entra directory on behalf of the signed-in Admin. graph is refused until the portal token is wired (B27, hand-off H1); mock is refused in prod',
      format: ['mock', 'graph'],
      default: 'mock',
      env: 'DIRECTORY_MODE'
    },
    allowedDomains: {
      doc: 'Comma-separated domains whose members may be added to a team, matched exactly against the UPN and mail',
      format: Array,
      default: ['defra.gov.uk', 'defra.onmicrosoft.com'],
      env: 'DIRECTORY_ALLOWED_DOMAINS'
    },
    graphBaseUrl: {
      doc: 'Microsoft Graph base URL, used when directory.mode is graph',
      format: 'url',
      default: 'https://graph.microsoft.com',
      env: 'DIRECTORY_GRAPH_BASE_URL'
    },
    timeoutMs: {
      doc: 'Timeout in ms for each Microsoft Graph or token call',
      format: 'nat',
      default: 5000,
      env: 'DIRECTORY_TIMEOUT_MS'
    },
    searchMaxPages: {
      doc: 'The most pages of 50 people one directory search reads, following Graph @odata.nextLink, so people who can be added are found behind members and ineligible people. A search that would need more returns what it read; the Admin narrows the search',
      format: (value) => {
        if (!Number.isInteger(value) || value < 1) {
          throw new TypeError('must be a whole number of at least 1')
        }
      },
      default: 5,
      env: 'DIRECTORY_SEARCH_MAX_PAGES'
    },
    searchTimeoutMs: {
      doc: 'Timeout in ms for the whole of one directory search across its pages, so a slow Graph cannot hold the Admin for pages times the per-call timeout',
      format: 'nat',
      default: 10000,
      env: 'DIRECTORY_SEARCH_TIMEOUT_MS'
    }
  },
  gitops: gitopsConfigSchema,
  aipEnvironments: {
    doc: 'AI Platform environments as JSON keyed by name: {subscriptionId, resourceGroup, apimName, foundryAccounts, tenantsVault}',
    format: 'aip-environments',
    default: {},
    env: 'AIP_ENVIRONMENTS'
  },
  audit: {
    retentionDays: {
      doc: 'Days to retain auditEvents before they expire (D08 working default)',
      format: 'nat',
      default: 30,
      env: 'AUDIT_RETENTION_DAYS'
    }
  },
  maintenanceToken: {
    doc: 'Shared secret required in the x-maintenance-token header for maintenance routes',
    format: String,
    nullable: true,
    default: null,
    env: 'MAINTENANCE_TOKEN'
  },
  maintenanceScheduler: {
    enabled: {
      doc: 'Whether the in-process scheduler runs credential expiry/reconciliation sweeps on an interval',
      format: Boolean,
      default: !isTest,
      env: 'MAINTENANCE_SCHEDULER_ENABLED'
    },
    intervalMs: {
      doc: 'Interval in ms between in-process credential expiry/reconciliation sweeps',
      format: 'nat',
      default: MAINTENANCE_INTERVAL_MINUTES * MS_PER_MINUTE,
      env: 'MAINTENANCE_SCHEDULER_INTERVAL_MS'
    }
  },
  serviceCode: {
    verifier: {
      doc: 'ServiceCodeVerifier that confirms a team service code is real. Only mock exists while no authoritative CDP/CCoE source is agreed',
      format: ['mock'],
      default: 'mock',
      env: 'SERVICE_CODE_VERIFIER'
    },
    knownCodes: {
      doc: 'Comma-separated service codes the mock verifier accepts as confirmed. Empty means every code stays "to be verified"',
      format: Array,
      default: [],
      env: 'SERVICE_CODE_KNOWN_CODES'
    }
  },
  provisioning: {
    mode: {
      doc: 'mock generates fake keys locally; live issues through each enabled gateway. "azure" is a deprecated alias for live',
      format: ['mock', 'live', 'azure'],
      default: 'mock',
      env: 'PROVISIONING_MODE'
    },
    gateways: {
      doc: 'Comma-separated catalogue gateway ids this environment can issue credentials through when provisioning.mode is live',
      format: Array,
      default: [DEFAULT_GATEWAY],
      env: 'ENABLED_GATEWAYS'
    },
    mockTiers: {
      doc: 'Comma-separated tiers (research, team) that use the mock issuer and vault even when provisioning.mode is live, e.g. to demo the team tier without a real team gateway. Not allowed in prod',
      format: Array,
      default: [],
      env: 'MOCK_TIERS'
    }
  },
  // Backend -> Azure ARM app registration, for the credential issuer only -
  // deliberately separate from the SSO `azureAd.*` registration in the
  // frontend's config.js (see the integration plan's "Identity" section for
  // why these must never share the plain AZURE_* names).
  armAuth: {
    tenantId: {
      doc: 'Entra ID tenant for the backend-to-ARM app registration',
      format: String,
      nullable: true,
      default: null,
      env: 'AZURE_ARM_TENANT_ID'
    },
    clientId: {
      doc: 'Client ID for the backend-to-ARM app registration',
      format: String,
      nullable: true,
      default: null,
      env: 'AZURE_ARM_CLIENT_ID'
    },
    clientSecret: {
      doc: 'Client secret for the backend-to-ARM app registration',
      format: String,
      nullable: true,
      default: null,
      sensitive: true,
      env: 'AZURE_ARM_CLIENT_SECRET'
    },
    authMethod: {
      doc: 'How the backend authenticates as the ARM app registration - federated (AWS STS web identity) everywhere except local, where there is no AWS STS to federate from',
      format: [ARM_AUTH_METHOD_CLIENT_SECRET, 'federated'],
      default: ARM_AUTH_METHOD_CLIENT_SECRET,
      env: 'AZURE_ARM_AUTH_METHOD'
    },
    federatedAudience: {
      doc: 'Audience (aud claim) of the AWS STS web identity token, must match the federated credential configured in Entra',
      format: String,
      default: 'api://AzureADTokenExchange',
      env: 'AZURE_ARM_FEDERATED_AUDIENCE'
    }
  },
  apim: {
    researchApiId: {
      doc: 'APIM API id the research tier subscription is scoped to (/apis/{id}, not a product)',
      format: String,
      default: 'research',
      env: 'APIM_RESEARCH_API_ID'
    }
  },
  catalogue: {
    source: {
      doc: 'Model catalogue source: file reads the local seed fixture, github reads ai-platform-infra at a pinned release',
      format: ['file', 'github'],
      default: 'file',
      env: 'CATALOGUE_SOURCE'
    },
    repo: {
      doc: 'owner/repo holding the catalogue, read when catalogue.source is "github"',
      format: String,
      default: 'DEFRA/ai-platform-infra',
      env: 'CATALOGUE_REPO'
    },
    ref: {
      doc: 'Pinned catalogue release tag to read, required when catalogue.source is "github"',
      format: String,
      nullable: true,
      default: null,
      env: 'CATALOGUE_REF'
    }
  },
  github: githubConfigSchema
})

config.validate({ allowed: 'strict' })

// The backend refuses to start without the identifiers every token is checked
// against, rather than accept tokens it cannot check.
for (const [key, name] of [
  ['portalAuth.tenantId', 'PORTAL_AUTH_TENANT_ID'],
  ['portalAuth.audience', 'PORTAL_AUTH_AUDIENCE'],
  ['portalAuth.clientId', 'PORTAL_AUTH_CLIENT_ID']
]) {
  if (!config.get(key)) {
    throw new Error(`${name} must be set`)
  }
}

if (isProduction && config.get('portalAuth.mockIssuerUrl')) {
  throw new Error('PORTAL_AUTH_MOCK_ISSUER_URL must not be set in production')
}

// Client secret is only required for the local-only client-secret auth
// method; federated auth proves identity via the AWS STS token instead.
const REQUIRED_ARM_AUTH_KEYS = [
  'armAuth.tenantId',
  'armAuth.clientId',
  ...(config.get('armAuth.authMethod') === ARM_AUTH_METHOD_CLIENT_SECRET
    ? ['armAuth.clientSecret']
    : ['armAuth.federatedAudience'])
]

// Every gateway the backend can run, with the config it needs when enabled.
// A new gateway (e.g. aws-apigw) adds its entry here, then its issuer and
// vault factories in the two adapter registries. Bedrock is a hosting
// platform behind APIM, not a gateway.
const REQUIRED_CONFIG_BY_GATEWAY = {
  [AZURE_APIM]: REQUIRED_ARM_AUTH_KEYS
}

// PROVISIONING_MODE=azure predates multi-cloud; the already-deployed CDP
// config still sets it, so it must keep working.
const PROVISIONING_MODE_KEY = 'provisioning.mode'

if (config.get(PROVISIONING_MODE_KEY) === 'azure') {
  config.set(PROVISIONING_MODE_KEY, 'live')
}

const provisioningMode = config.get(PROVISIONING_MODE_KEY)

// Production refuses to start with a mock gateway selected for any of the
// direct paths (design fact). Fail fast here rather than at the first issued
// credential, and fail fast again if a live gateway is enabled without the
// config it needs rather than surfacing a 401 from its gateway.
if (config.get('cdpEnvironment') === 'prod' && provisioningMode === 'mock') {
  throw new Error(
    'PROVISIONING_MODE must not be "mock" in the prod environment'
  )
}

const mockTiers = config.get('provisioning.mockTiers')

const unknownMockTiers = mockTiers.filter(
  (tier) => !['research', 'team'].includes(tier)
)

if (unknownMockTiers.length > 0) {
  throw new Error(
    `MOCK_TIERS contains unknown tier "${unknownMockTiers[0]}" (known: research, team)`
  )
}

if (config.get('cdpEnvironment') === 'prod' && mockTiers.length > 0) {
  throw new Error('MOCK_TIERS must be empty in the prod environment')
}

if (provisioningMode === 'live') {
  for (const gateway of config.get('provisioning.gateways')) {
    const requiredKeys = REQUIRED_CONFIG_BY_GATEWAY[gateway]

    if (!requiredKeys) {
      throw new Error(
        `ENABLED_GATEWAYS contains unknown gateway "${gateway}" (known: ${Object.keys(REQUIRED_CONFIG_BY_GATEWAY).join(', ')})`
      )
    }

    const missing = requiredKeys.filter((key) => !config.get(key))

    if (missing.length > 0) {
      throw new Error(
        `Gateway ${gateway} requires ${missing.join(', ')} to be set`
      )
    }
  }
}

if (!/^[a-z][a-z0-9]{1,15}$/.test(config.get('research.environment'))) {
  throw new Error(
    'RESEARCH_ENVIRONMENT must be a lowercase environment name such as infradev'
  )
}

// The subscription, resource group, API Management instance and vault the
// research tier issues into all come from the one AIP_ENVIRONMENTS entry, so a
// missing one must stop the boot rather than fail the first issued key.
if (
  provisioningMode === 'live' &&
  config.get('provisioning.gateways').includes(AZURE_APIM) &&
  !mockTiers.includes('research')
) {
  const researchEnvironment = config.get('research.environment')
  const environment = config.get('aipEnvironments')[researchEnvironment]

  if (!environment?.apimName || !environment?.tenantsVault) {
    throw new Error(
      `RESEARCH_ENVIRONMENT "${researchEnvironment}" must be in AIP_ENVIRONMENTS with an apimName and a tenantsVault`
    )
  }
}

const isGithubAppAuth =
  config.get('github.appId') || config.get('github.clientId')

if (isGithubAppAuth && !config.get('github.installationId')) {
  throw new Error(
    'GITHUB_APP_ID/GITHUB_CLIENT_ID requires GITHUB_APP_INSTALLATION_ID to be set'
  )
}

if (isGithubAppAuth && !config.get('github.privateKey')) {
  throw new Error(
    'GITHUB_APP_ID/GITHUB_CLIENT_ID requires GITHUB_APP_PRIVATE_KEY to be set'
  )
}

// The queue mode reads team files and corroborates runs with the App's read
// tokens, and needs the commands topic and the events queue.
if (config.get('tenantOrchestrator') === 'sqs') {
  if (!isGithubAppAuth) {
    throw new Error(
      'TENANT_ORCHESTRATOR=sqs requires GITHUB_CLIENT_ID or GITHUB_APP_ID (a GitHub App) to be set'
    )
  }

  const missingQueues = [
    ['GITOPS_COMMANDS_TOPIC_ARN', 'gitops.commandsTopicArn'],
    ['GITOPS_EVENTS_QUEUE_URL', 'gitops.eventsQueueUrl']
  ].filter(([, key]) => !config.get(key))

  if (missingQueues.length > 0) {
    throw new Error(
      `TENANT_ORCHESTRATOR=sqs requires ${missingQueues.map(([name]) => name).join(' and ')} to be set`
    )
  }
}
