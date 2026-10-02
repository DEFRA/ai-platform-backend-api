import convict from 'convict'
import convictFormatWithValidator from 'convict-format-with-validator'

import { convictValidateMongoUri } from '#/common/helpers/convict/validate-mongo-uri.js'

convict.addFormat(convictValidateMongoUri)
convict.addFormats(convictFormatWithValidator)

const isProduction = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'

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
  allowedEmailDomains: {
    doc: 'Comma-separated list of email domains allowed to sign in',
    format: String,
    default: 'defra.gov.uk',
    env: 'ALLOWED_EMAIL_DOMAINS'
  },
  research: {
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
    }
  },
  teamDeployment: {
    mockStageDurationMs: {
      doc: 'Duration in ms of each mocked GitOps stage for team deployment provisioning',
      format: 'nat',
      default: 3000,
      env: 'TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS'
    }
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
  provisioning: {
    mode: {
      doc: 'Credential issuing provider: mock generates fake keys locally, azure calls Azure Resource Manager against real APIM',
      format: ['mock', 'azure'],
      default: 'mock',
      env: 'PROVISIONING_MODE'
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
    subscriptionId: {
      doc: 'Azure subscription ID that hosts APIM',
      format: String,
      nullable: true,
      default: null,
      env: 'AZURE_ARM_SUBSCRIPTION_ID'
    },
    resourceGroup: {
      doc: 'Resource group that hosts the APIM instance',
      format: String,
      nullable: true,
      default: null,
      env: 'AZURE_ARM_RESOURCE_GROUP'
    }
  },
  apim: {
    serviceName: {
      doc: 'APIM service (instance) name',
      format: String,
      nullable: true,
      default: null,
      env: 'APIM_SERVICE_NAME'
    },
    researchApiId: {
      doc: 'APIM API id the research tier subscription is scoped to (/apis/{id}, not a product)',
      format: String,
      default: 'research',
      env: 'APIM_RESEARCH_API_ID'
    }
  },
  // Backend -> Azure Key Vault data plane, for the credential vault only -
  // shares the armAuth.* credential (see azure-credential.js) but talks to
  // a different host/token audience than ARM, so it gets its own key.
  keyVault: {
    vaultName: {
      doc: 'Name of the tenants Key Vault (kv-aip-{env}-tenants) credential secrets are persisted to',
      format: String,
      nullable: true,
      default: null,
      env: 'AZURE_KEY_VAULT_NAME'
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
  github: {
    token: {
      doc: 'Fine-grained GitHub PAT with Contents:Read on the catalogue repo (or use the App credentials below)',
      format: String,
      nullable: true,
      default: null,
      sensitive: true,
      env: 'GITHUB_TOKEN'
    },
    appId: {
      doc: 'GitHub App ID, an alternative to github.token',
      format: String,
      nullable: true,
      default: null,
      env: 'GITHUB_APP_ID'
    },
    installationId: {
      doc: 'GitHub App installation ID, required alongside github.appId',
      format: String,
      nullable: true,
      default: null,
      env: 'GITHUB_APP_INSTALLATION_ID'
    },
    privateKey: {
      doc: 'GitHub App private key, required alongside github.appId',
      format: String,
      nullable: true,
      default: null,
      sensitive: true,
      env: 'GITHUB_APP_PRIVATE_KEY'
    }
  }
})

config.validate({ allowed: 'strict' })

const REQUIRED_ARM_AUTH_KEYS = [
  'armAuth.tenantId',
  'armAuth.clientId',
  'armAuth.clientSecret',
  'armAuth.subscriptionId',
  'armAuth.resourceGroup',
  'apim.serviceName',
  'keyVault.vaultName'
]

// Design fact: "Production refuses to start with a mock adapter selected for
// any of the direct paths." Fail fast here rather than at the first issued
// credential, and fail fast again if azure mode is selected without the
// config it needs rather than surfacing a 401 from ARM.
if (
  config.get('cdpEnvironment') === 'prod' &&
  config.get('provisioning.mode') === 'mock'
) {
  throw new Error(
    'PROVISIONING_MODE must not be "mock" in the prod environment'
  )
}

if (config.get('provisioning.mode') === 'azure') {
  const missing = REQUIRED_ARM_AUTH_KEYS.filter((key) => !config.get(key))

  if (missing.length > 0) {
    throw new Error(
      `PROVISIONING_MODE=azure requires ${missing.join(', ')} to be set`
    )
  }
}
