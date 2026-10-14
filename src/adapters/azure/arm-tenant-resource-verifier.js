import { config } from '#/config.js'
import { createArmClient } from '#/adapters/azure/arm-client.js'

// ARM needs a provider-specific api-version on every read. Only the types a
// team's Terraform outputs can name are listed; an unknown type fails
// verification rather than being skipped, so nothing goes unchecked.
const API_VERSION_BY_RESOURCE_TYPE = {
  'microsoft.apimanagement/service': '2024-05-01',
  'microsoft.apimanagement/service/apis': '2024-05-01',
  'microsoft.cognitiveservices/accounts': '2025-06-01',
  'microsoft.cognitiveservices/accounts/deployments': '2025-06-01',
  'microsoft.cognitiveservices/accounts/projects': '2025-06-01',
  'microsoft.keyvault/vaults': '2023-07-01',
  'microsoft.managedidentity/userassignedidentities': '2023-01-31'
}

const ARM_RESOURCE_ID =
  /^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\//i

/**
 * Every ARM resource ID (a string starting `/subscriptions/.../providers/`)
 * anywhere in a team's Terraform outputs, deduplicated. Other values, such
 * as Entra object IDs or names, are ignored.
 * @param {unknown} outputs
 * @returns {string[]}
 */
export function collectResourceIds(outputs) {
  const ids = new Set()

  function visit(value) {
    if (typeof value === 'string') {
      if (ARM_RESOURCE_ID.test(value)) {
        ids.add(value)
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(visit)
    }
  }

  visit(outputs)

  return [...ids]
}

function resourceTypeOf(resourceId) {
  const segments = resourceId.split('/providers/').pop().split('/')
  const [namespace, ...rest] = segments
  const types = rest.filter((_, index) => index % 2 === 0)

  return [namespace, ...types].join('/').toLowerCase()
}

function isInEnvironment(resourceId, { subscriptionId, resourceGroup }) {
  return resourceId
    .toLowerCase()
    .startsWith(
      `/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/`.toLowerCase()
    )
}

/**
 * Creates the ARM-backed `TenantResourceVerifier`: every resource ID in the
 * team's outputs must sit in the environment's subscription and resource
 * group (from `AIP_ENVIRONMENTS`), exist, and report `provisioningState`
 * `Succeeded` where the type reports one. Reads only; failures return a
 * stable `reason` code and never the ARM response body.
 * @param {{armClient?: ReturnType<typeof createArmClient>, environments?: Record<string, {subscriptionId: string, resourceGroup: string}>}} [deps]
 * @returns {import('#/adapters/tenant-resource-verifier.js').TenantResourceVerifier}
 */
export function createArmTenantResourceVerifier({
  armClient = createArmClient(),
  environments = config.get('aipEnvironments')
} = {}) {
  async function verifyResource(resourceId) {
    const apiVersion = API_VERSION_BY_RESOURCE_TYPE[resourceTypeOf(resourceId)]

    if (!apiVersion) {
      return 'unsupported-resource-type'
    }

    let resource

    try {
      resource = await armClient.request(
        'GET',
        `${resourceId}?api-version=${apiVersion}`
      )
    } catch {
      return 'resource-unavailable'
    }

    // Some child types (API Management APIs) report no provisioningState;
    // for those, existence is the proof.
    const state = resource?.properties?.provisioningState

    if (!resource) {
      return 'resource-unavailable'
    }

    return state === undefined || state === 'Succeeded'
      ? null
      : 'resource-not-succeeded'
  }

  return {
    async verify({ environment, resources }) {
      const settings = environments[environment]

      if (!settings) {
        return { verified: false, reason: 'environment-not-configured' }
      }

      const resourceIds = collectResourceIds(resources)

      if (resourceIds.length === 0) {
        return { verified: false, reason: 'no-resources' }
      }

      if (!resourceIds.every((id) => isInEnvironment(id, settings))) {
        return { verified: false, reason: 'resource-outside-environment' }
      }

      for (const resourceId of resourceIds) {
        const reason = await verifyResource(resourceId)

        if (reason) {
          return { verified: false, reason }
        }
      }

      return { verified: true }
    }
  }
}
