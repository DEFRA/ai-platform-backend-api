import { config } from '#/config.js'
import { createArmClient } from '#/adapters/azure/arm-client.js'
import { resolveAipEnvironment } from '#/common/helpers/aip-environment.js'

const API_VERSION = '2024-05-01'
const ARM_ORIGIN = 'https://management.azure.com'

// Created by API Management itself and not ours to judge.
const BUILT_IN_SUBSCRIPTION = 'master'

// Every research subscription is named from this prefix (see `sidFor`).
const RESEARCH_SUBSCRIPTION_PREFIX = 'research-'

// An ARM resource ID path (no https:// host) - used both to build request
// URLs under ARM_BASE_URL and, unprefixed, as the `scope` value ARM
// expects on the subscription resource itself.
function serviceBasePath({ subscriptionId, resourceGroup, apimName }) {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${apimName}`
}

function subscriptionPath(base, sid, suffix = '') {
  return `${base}/subscriptions/${sid}${suffix}?api-version=${API_VERSION}`
}

// Deterministic so a retry after a timeout updates the same APIM
// subscription instead of minting a second one. Only research credentials
// are subscription keys; the team tier is OAuth only.
function sidFor({ userId, modelSlug }) {
  return `${RESEARCH_SUBSCRIPTION_PREFIX}${userId}-${modelSlug}`
}

/**
 * Why a subscription is not a research key on the research API (none for the
 * built-in one, or when it is one).
 * @param {{name: string, properties?: {scope?: string}}} subscription
 * @param {string} researchScope
 * @returns {string[]}
 */
function strayReasons(subscription, researchScope) {
  if (subscription.name === BUILT_IN_SUBSCRIPTION) {
    return []
  }

  const reasons = []

  if (!subscription.name.startsWith(RESEARCH_SUBSCRIPTION_PREFIX)) {
    reasons.push('unexpected-name')
  }

  if (
    subscription.properties?.scope?.toLowerCase() !==
    researchScope.toLowerCase()
  ) {
    reasons.push('unexpected-scope')
  }

  return reasons
}

// Follows a next link only while it stays on the ARM host.
function nextArmPath(page) {
  return page?.nextLink?.startsWith(ARM_ORIGIN)
    ? page.nextLink.slice(ARM_ORIGIN.length)
    : null
}

// Pages are chained, so each request needs the previous page's next link.
async function listStraySubscriptions(armClient, path, researchScope) {
  const page = await armClient.request('GET', path)
  const strays = (page?.value ?? [])
    .map((subscription) => ({
      name: subscription.name,
      reasons: strayReasons(subscription, researchScope)
    }))
    .filter(({ reasons }) => reasons.length > 0)
  const next = nextArmPath(page)

  return next
    ? [
        ...strays,
        ...(await listStraySubscriptions(armClient, next, researchScope))
      ]
    : strays
}

async function issueSubscription(armClient, base, { userId, modelSlug }) {
  const sid = sidFor({ userId, modelSlug })
  const researchApiId = config.get('apim.researchApiId')
  const ttlDays = config.get('research.credentialTtlDays')
  const expiresAt = new Date(
    Date.now() + ttlDays * 24 * 60 * 60 * 1000
  ).toISOString()

  await armClient.request('PUT', subscriptionPath(base, sid), {
    body: {
      properties: {
        scope: `${base}/apis/${researchApiId}`,
        displayName: sid,
        state: 'active',
        // Mirrors the Mongo-side expiresAt, so APIM's own
        // context.Subscription.EndDate (policy-readable) agrees with Mongo
        // from the moment a credential is first issued.
        expirationDate: expiresAt
      }
    }
  })

  // The key is never returned by PUT or GET - listSecrets is the only way to read it.
  const secrets = await armClient.request(
    'POST',
    subscriptionPath(base, sid, '/listSecrets')
  )

  return {
    externalId: sid,
    secret: secrets.primaryKey,
    keyHint: secrets.primaryKey.slice(-4),
    expiresAt
  }
}

// Two PATCH calls, not one: ARM rejects {state: 'active', expirationDate} in
// one request while the subscription is suspended (confirmed against real
// APIM), and renewing a suspended, expired credential is the normal case.
async function renewSubscription(armClient, base, externalId, expiresAt) {
  await armClient.request('PATCH', subscriptionPath(base, externalId), {
    body: { properties: { state: 'active' } },
    ifMatch: '*'
  })

  await armClient.request('PATCH', subscriptionPath(base, externalId), {
    body: { properties: { expirationDate: expiresAt } },
    ifMatch: '*'
  })
}

/**
 * Creates the real Azure APIM-backed `CredentialIssuer`, talking to the ARM
 * management plane (never APIM's own APIs - see the integration plan's
 * "Critical correction" section). It issues research subscription keys only,
 * scoped to the API itself (`/apis/{id}`), never a product - APIM products
 * are not used by this design. The team tier is OAuth only and never reaches
 * it (see `credential-issuer-registry.js`). Every call names the environment
 * the credential lives in; the subscription, resource group and API
 * Management instance are resolved from it per call, so one backend can
 * serve credentials issued into more than one environment.
 * @param {{armClient?: ReturnType<typeof createArmClient>, resolveEnvironment?: typeof resolveAipEnvironment}} [deps]
 * @returns {import('#/adapters/credential-issuer.js').CredentialIssuer}
 */
export function createApimCredentialIssuer({
  armClient = createArmClient(),
  resolveEnvironment = resolveAipEnvironment
} = {}) {
  function baseFor(environment) {
    return serviceBasePath(resolveEnvironment(environment))
  }

  return {
    async issue({ userId, modelSlug, environment }) {
      return issueSubscription(armClient, baseFor(environment), {
        userId,
        modelSlug
      })
    },

    async renew({ externalId, expiresAt, environment }) {
      await renewSubscription(
        armClient,
        baseFor(environment),
        externalId,
        expiresAt
      )

      return { externalId }
    },

    async rotate({ externalId, environment }) {
      const base = baseFor(environment)

      // Let Azure mint the key rather than supplying our own. Returns 204
      // with no body, hence the second call.
      await armClient.request(
        'POST',
        subscriptionPath(base, externalId, '/regeneratePrimaryKey')
      )

      const secrets = await armClient.request(
        'POST',
        subscriptionPath(base, externalId, '/listSecrets')
      )

      return {
        externalId,
        secret: secrets.primaryKey,
        keyHint: secrets.primaryKey.slice(-4)
      }
    },

    async revoke({ externalId, environment }) {
      await armClient.request(
        'DELETE',
        subscriptionPath(baseFor(environment), externalId),
        { ifMatch: '*' }
      )

      return { externalId }
    },

    async suspend({ externalId, environment }) {
      await armClient.request(
        'PATCH',
        subscriptionPath(baseFor(environment), externalId),
        {
          body: { properties: { state: 'suspended' } },
          ifMatch: '*'
        }
      )

      return { externalId }
    },

    // The portal's API Management role can write a subscription scoped to
    // any API, so this is the compensating control: anything on the instance
    // that is not a research key on the research API is reported.
    async findStraySubscriptions({ environment }) {
      const base = baseFor(environment)

      return listStraySubscriptions(
        armClient,
        `${base}/subscriptions?api-version=${API_VERSION}`,
        `${base}/apis/${config.get('apim.researchApiId')}`
      )
    }
  }
}
