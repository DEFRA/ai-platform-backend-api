import { config } from '#/config.js'
import { createArmClient } from '#/adapters/azure/arm-client.js'

const API_VERSION = '2024-05-01'

function buildServiceBasePath() {
  const subscriptionId = config.get('armAuth.subscriptionId')
  const resourceGroup = config.get('armAuth.resourceGroup')
  const apimServiceName = config.get('apim.serviceName')

  // An ARM resource ID path (no https:// host) - used both to build request
  // URLs under ARM_BASE_URL and, unprefixed, as the `scope` value ARM
  // expects on the subscription resource itself.
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${apimServiceName}`
}

function subscriptionPath(sid, suffix = '') {
  return `${buildServiceBasePath()}/subscriptions/${sid}${suffix}?api-version=${API_VERSION}`
}

// Deterministic per tier so a retry after a timeout updates the same APIM
// subscription instead of minting a second one.
function sidFor({ userId, modelSlug, tier, teamId, environment }) {
  return tier === 'team'
    ? `team-${teamId}-${environment}`
    : `research-${userId}-${modelSlug}`
}

/**
 * Creates the real Azure APIM-backed `CredentialIssuer`, talking to the ARM
 * management plane (never APIM's own APIs - see the integration plan's
 * "Critical correction" section). The research subscription is scoped to
 * the API itself (`/apis/{id}`), never a product - APIM products are not
 * used by this design.
 * @param {{armClient?: ReturnType<typeof createArmClient>}} [deps]
 * @returns {import('#/adapters/credential-issuer.js').CredentialIssuer}
 */
export function createApimCredentialIssuer({
  armClient = createArmClient()
} = {}) {
  return {
    async issue({ userId, modelSlug, tier = 'research', teamId, environment }) {
      const sid = sidFor({ userId, modelSlug, tier, teamId, environment })
      const researchApiId = config.get('apim.researchApiId')
      const ttlDays = config.get('research.credentialTtlDays')
      const expiresAt = new Date(
        Date.now() + ttlDays * 24 * 60 * 60 * 1000
      ).toISOString()

      await armClient.request('PUT', subscriptionPath(sid), {
        body: {
          properties: {
            scope: `${buildServiceBasePath()}/apis/${researchApiId}`,
            displayName: sid,
            state: 'active',
            // Mirrors the Mongo-side expiresAt below, so APIM's own
            // context.Subscription.EndDate (policy-readable) agrees with
            // Mongo from the moment a credential is first issued - not just
            // after its first renewal.
            expirationDate: expiresAt
          }
        }
      })

      // The key is never returned by PUT or GET - listSecrets is the only way to read it.
      const secrets = await armClient.request(
        'POST',
        subscriptionPath(sid, '/listSecrets')
      )

      return {
        externalId: sid,
        secret: secrets.primaryKey,
        keyHint: secrets.primaryKey.slice(-4),
        expiresAt
      }
    },

    async renew({ externalId, expiresAt }) {
      // Two separate PATCH calls, not one combined body - ARM rejects
      // {state: 'active', expirationDate} in a single request with
      // "Only 'active' subscriptions can be renewed" when the subscription
      // is currently suspended (confirmed against real APIM). State must
      // already be active before expirationDate can be set, since a
      // renew() following expireCredentials()'s suspend() is exactly how a
      // lapsed research credential comes back to life (per the design:
      // renewal is blocked only by revoked status or the renewal cap,
      // never by having already expired).
      await armClient.request('PATCH', subscriptionPath(externalId), {
        body: { properties: { state: 'active' } },
        ifMatch: '*'
      })

      await armClient.request('PATCH', subscriptionPath(externalId), {
        body: { properties: { expirationDate: expiresAt } },
        ifMatch: '*'
      })

      return { externalId }
    },

    async rotate({ externalId }) {
      // Let Azure mint the key rather than supplying our own. Returns 204
      // with no body, hence the second call.
      await armClient.request(
        'POST',
        subscriptionPath(externalId, '/regeneratePrimaryKey')
      )

      const secrets = await armClient.request(
        'POST',
        subscriptionPath(externalId, '/listSecrets')
      )

      return {
        externalId,
        secret: secrets.primaryKey,
        keyHint: secrets.primaryKey.slice(-4)
      }
    },

    async revoke({ externalId }) {
      await armClient.request('DELETE', subscriptionPath(externalId), {
        ifMatch: '*'
      })

      return { externalId }
    },

    async suspend({ externalId }) {
      await armClient.request('PATCH', subscriptionPath(externalId), {
        body: { properties: { state: 'suspended' } },
        ifMatch: '*'
      })

      return { externalId }
    }
  }
}
