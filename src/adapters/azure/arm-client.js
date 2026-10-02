import { getArmCredential } from '#/adapters/azure/azure-credential.js'

const ARM_BASE_URL = 'https://management.azure.com'
const ARM_SCOPE = 'https://management.azure.com/.default'

/**
 * Creates a single-purpose Azure Resource Manager request client. Knows
 * nothing about credentials, subscriptions or models - callers supply the
 * full ARM path (starting `/subscriptions/...`) and get back parsed JSON (or
 * `null` for a 204). Never `{apim}.management.azure-api.net` - always
 * `management.azure.com`, authenticated with an Entra bearer token.
 * @param {{getCredential?: () => import('@azure/identity').TokenCredential}} [deps]
 * @returns {{request: (method: string, path: string, options?: {body?: object, ifMatch?: string}) => Promise<object|null>}}
 */
export function createArmClient({ getCredential = getArmCredential } = {}) {
  async function request(method, path, { body, ifMatch } = {}) {
    const credential = getCredential()
    const token = await credential.getToken(ARM_SCOPE)

    const headers = {
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json'
    }

    if (ifMatch) {
      headers['if-match'] = ifMatch
    }

    const response = await fetch(`${ARM_BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    })

    if (!response.ok) {
      // Never include the response body - on `listSecrets` it can carry the
      // subscription key, and this message may end up in logs or an error path.
      throw new Error(`ARM request failed: ${method} ${path} -> ${response.status}`)
    }

    // ARM doesn't reliably use 204 for an empty body - a subscription DELETE
    // can come back 200 with nothing to parse, so check the body itself
    // rather than trusting the status code.
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }

  return { request }
}
