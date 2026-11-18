import {
  accessWindowNamedValueName,
  formatAccessWindow,
  parseAccessWindow
} from '#/adapters/access-window-format.js'
import { createArmClient } from '#/adapters/azure/arm-client.js'
import {
  API_VERSION,
  serviceBasePath
} from '#/adapters/azure/apim-credential-issuer.js'
import { config } from '#/config.js'
import { resolveAipEnvironment } from '#/common/helpers/aip-environment.js'

/**
 * Creates the real `AccessWindowStore` over the API Management named value
 * `aip-{slug}-access` that each team API's policy reads. The backend's role
 * can write any named value (RBAC scopes to the instance, T20), so this is
 * the only place that limits it: the name comes from a valid team slug and
 * nothing else, and the value from the fixed format. The value is changed in
 * place with a PATCH, so a missing named value is an error, never a new one;
 * Terraform creates it as `none`. The caller serialises a read and its write
 * under the credential block lock, so the write does not check the ETag. A
 * write API Management has not finished within `writeWaitMs` rejects (the
 * caller fails closed and a retry repeats the same write).
 * @param {{armClient?: ReturnType<typeof createArmClient>, resolveEnvironment?: typeof resolveAipEnvironment, writeWaitMs?: number}} [deps]
 * @returns {import('#/adapters/access-window-store.js').AccessWindowStore}
 */
export function createApimAccessWindowStore({
  armClient = createArmClient(),
  resolveEnvironment = resolveAipEnvironment,
  writeWaitMs = config.get('accessWindowWaitMs')
} = {}) {
  function namedValuePath(environment, teamSlug) {
    const name = accessWindowNamedValueName(teamSlug)
    const base = serviceBasePath(resolveEnvironment(environment))

    return `${base}/namedValues/${name}?api-version=${API_VERSION}`
  }

  return {
    async read({ environment, teamSlug }) {
      const namedValue = await armClient.request(
        'GET',
        namedValuePath(environment, teamSlug)
      )

      return parseAccessWindow(namedValue?.properties?.value)
    },

    async write({ environment, teamSlug, entries }) {
      const path = namedValuePath(environment, teamSlug)

      await armClient.request('PATCH', path, {
        body: { properties: { value: formatAccessWindow(entries) } },
        ifMatch: '*',
        maxWaitMs: writeWaitMs
      })
    }
  }
}
