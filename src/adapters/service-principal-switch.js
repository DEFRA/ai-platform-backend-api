const GUID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/**
 * Port for turning a team registration's service principal on or off in
 * Entra, so no new token is issued to any of its applications or secrets
 * (design F, "Disable credentials"). It switches `accountEnabled` and does not
 * decide when: the credential block does. A call is idempotent, and a failure
 * rejects so the caller keeps the block.
 * @typedef {object} ServicePrincipalSwitch
 * @property {(params: {environment: string, objectId: string, enabled: boolean}) => Promise<{objectId: string, enabled: boolean}>} setAccountEnabled - `objectId` is the service principal's Entra object ID, never the application's
 */

function refuse(message) {
  const error = new Error(message)
  error.code = 'invalid-service-principal-switch'
  return error
}

/**
 * Refuses a request an adapter must never act on. Every adapter calls it first.
 * @param {{environment?: unknown, objectId?: unknown, enabled?: unknown}} request
 */
export function assertSwitchRequest({ environment, objectId, enabled }) {
  if (typeof environment !== 'string' || environment.length === 0) {
    throw refuse('A service principal switch needs an environment')
  }

  if (typeof objectId !== 'string' || !GUID_PATTERN.test(objectId)) {
    throw refuse('A service principal is named by its object ID, a GUID')
  }

  if (typeof enabled !== 'boolean') {
    throw refuse('A service principal is switched to enabled or disabled')
  }
}
