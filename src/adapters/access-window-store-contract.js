const CLIENT_A = '11111111-2222-4333-8444-555555555555'
const CLIENT_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const ordinary = {
  clientId: CLIENT_A,
  status: 'active',
  validFrom: '2026-11-01T00:00:00Z',
  expiresAt: 'untilRevoked'
}
const blocked = {
  clientId: CLIENT_B,
  status: 'suspended',
  validFrom: '2026-11-01T00:00:00Z',
  expiresAt: '2026-12-01T00:00:00Z'
}

/**
 * Shared `AccessWindowStore` contract suite, run against the mock and the
 * nocked APIM adapter so each is a drop-in for the other: a window nobody has
 * written is empty, a write replaces the whole window, one team's window never
 * changes another's, and anything outside the fixed format is refused with the
 * stored window unchanged.
 * @param {string} name
 * @param {() => import('./access-window-store.js').AccessWindowStore} createStore - a store in which every window starts empty
 * @param {{environment?: string, otherEnvironment?: string}} [options]
 */
export function describeAccessWindowStoreContract(
  name,
  createStore,
  { environment = 'infradev', otherEnvironment = 'sandbox' } = {}
) {
  const teamSlug = 'contract-team'

  describe(`AccessWindowStore contract: ${name}`, () => {
    test('reads a window nobody has written as no entries', async () => {
      await expect(
        createStore().read({ environment, teamSlug })
      ).resolves.toEqual([])
    })

    test('reads back the entries it was given', async () => {
      const store = createStore()

      await store.write({ environment, teamSlug, entries: [ordinary, blocked] })

      await expect(store.read({ environment, teamSlug })).resolves.toEqual([
        ordinary,
        blocked
      ])
    })

    test('replaces the whole window on a write, and an empty list clears it', async () => {
      const store = createStore()

      await store.write({ environment, teamSlug, entries: [ordinary, blocked] })
      await store.write({ environment, teamSlug, entries: [blocked] })

      await expect(store.read({ environment, teamSlug })).resolves.toEqual([
        blocked
      ])

      await store.write({ environment, teamSlug, entries: [] })

      await expect(store.read({ environment, teamSlug })).resolves.toEqual([])
    })

    test('writing the same window twice leaves it as written', async () => {
      const store = createStore()

      await store.write({ environment, teamSlug, entries: [blocked] })
      await store.write({ environment, teamSlug, entries: [blocked] })

      await expect(store.read({ environment, teamSlug })).resolves.toEqual([
        blocked
      ])
    })

    test('keeps one team and one environment apart from another', async () => {
      const store = createStore()

      await store.write({ environment, teamSlug, entries: [ordinary] })

      await expect(
        store.read({ environment, teamSlug: 'other-team' })
      ).resolves.toEqual([])
      await expect(
        store.read({ environment: otherEnvironment, teamSlug })
      ).resolves.toEqual([])
    })

    test.each([
      ['a client that is not a GUID', { ...ordinary, clientId: 'client-1' }],
      ['a status outside the list', { ...ordinary, status: 'expired' }],
      ['a validFrom that is not UTC', { ...ordinary, validFrom: '2026-11-01' }],
      ['an expiresAt that is not a time', { ...ordinary, expiresAt: 'never' }],
      [
        'an expression in a field',
        { ...ordinary, clientId: `${CLIENT_A}"; Foo(); //` }
      ]
    ])('refuses %s and keeps the window it held', async (_, entry) => {
      const store = createStore()

      await store.write({ environment, teamSlug, entries: [blocked] })

      await expect(
        store.write({ environment, teamSlug, entries: [entry] })
      ).rejects.toMatchObject({ code: 'invalid-access-window' })
      await expect(store.read({ environment, teamSlug })).resolves.toEqual([
        blocked
      ])
    })

    test('refuses the same client twice', async () => {
      await expect(
        createStore().write({
          environment,
          teamSlug,
          entries: [ordinary, { ...ordinary, status: 'suspended' }]
        })
      ).rejects.toMatchObject({ code: 'invalid-access-window' })
    })

    test.each(['', 'Cool-Team', 'team/../deny-list', 'team?x=1'])(
      'refuses the team slug %j on a read and a write',
      async (badSlug) => {
        const store = createStore()

        await expect(
          store.read({ environment, teamSlug: badSlug })
        ).rejects.toMatchObject({ code: 'invalid-team-slug' })
        await expect(
          store.write({ environment, teamSlug: badSlug, entries: [] })
        ).rejects.toMatchObject({ code: 'invalid-team-slug' })
      }
    )
  })
}
