import { assertSwitchRequest } from '#/adapters/service-principal-switch.js'

/**
 * Creates an in-memory `ServicePrincipalSwitch` that remembers the last state
 * it was given and reaches nothing in Entra. `enabledState` is for tests and
 * is not part of the port.
 * @returns {import('#/adapters/service-principal-switch.js').ServicePrincipalSwitch & {enabledState: (environment: string, objectId: string) => boolean|undefined}}
 */
export function createMockServicePrincipalSwitch() {
  const states = new Map()

  return {
    async setAccountEnabled({ environment, objectId, enabled }) {
      assertSwitchRequest({ environment, objectId, enabled })

      states.set(`${environment}/${objectId.toLowerCase()}`, enabled)

      return { objectId, enabled }
    },

    enabledState(environment, objectId) {
      return states.get(`${environment}/${objectId.toLowerCase()}`)
    }
  }
}

export const mockServicePrincipalSwitch = createMockServicePrincipalSwitch()
