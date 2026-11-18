const OBJECT_ID = '5eed0000-0000-4000-8000-000000000001'

/**
 * Shared `ServicePrincipalSwitch` contract suite, run against the mock now and
 * the Graph adapter when it arrives, so each is a drop-in for the other: the
 * answer echoes the request, a repeat is a no-op, a switch goes both ways, and
 * anything but a GUID and a boolean is refused.
 * @param {string} name
 * @param {() => import('./service-principal-switch.js').ServicePrincipalSwitch} createSwitch
 * @param {{environment?: string}} [options]
 */
export function describeServicePrincipalSwitchContract(
  name,
  createSwitch,
  { environment = 'infradev' } = {}
) {
  describe(`ServicePrincipalSwitch contract: ${name}`, () => {
    test.each([false, true])(
      'answers the object ID and the state it was asked for (enabled %s)',
      async (enabled) => {
        await expect(
          createSwitch().setAccountEnabled({
            environment,
            objectId: OBJECT_ID,
            enabled
          })
        ).resolves.toEqual({ objectId: OBJECT_ID, enabled })
      }
    )

    test('a repeat of the same request answers the same and does not fail', async () => {
      const switchBoard = createSwitch()
      const request = { environment, objectId: OBJECT_ID, enabled: false }

      const first = await switchBoard.setAccountEnabled(request)

      await expect(switchBoard.setAccountEnabled(request)).resolves.toEqual(
        first
      )
    })

    test('switches off and on again', async () => {
      const switchBoard = createSwitch()

      await switchBoard.setAccountEnabled({
        environment,
        objectId: OBJECT_ID,
        enabled: false
      })

      await expect(
        switchBoard.setAccountEnabled({
          environment,
          objectId: OBJECT_ID,
          enabled: true
        })
      ).resolves.toEqual({ objectId: OBJECT_ID, enabled: true })
    })

    test.each([
      ['an object ID that is not a GUID', { objectId: 'sp-1' }],
      ['an empty object ID', { objectId: '' }],
      ['no object ID', { objectId: null }],
      ['an object ID with a path in it', { objectId: `${OBJECT_ID}/../x` }],
      ['a state that is not a boolean', { enabled: 'false' }],
      ['no state', { enabled: null }],
      ['no environment', { environment: null }]
    ])('refuses %s', async (_, change) => {
      await expect(
        createSwitch().setAccountEnabled({
          environment,
          objectId: OBJECT_ID,
          enabled: false,
          ...change
        })
      ).rejects.toMatchObject({ code: 'invalid-service-principal-switch' })
    })
  })
}
