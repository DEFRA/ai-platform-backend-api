/**
 * Shared `TeamConnectionDetails` contract suite, run against every
 * implementation so each is a drop-in for the other: the details have exactly
 * the port's keys, with strings for every value and a boolean `placeholder`,
 * and are the same for the same team and environment.
 * @param {string} name
 * @param {() => import('./team-connection-details.js').TeamConnectionDetails} createAdapter
 */
export function describeTeamConnectionDetailsContract(name, createAdapter) {
  const params = { team: { slug: 'contract-team' }, environment: 'infradev' }

  describe(`TeamConnectionDetails contract: ${name}`, () => {
    test('detailsFor returns exactly the port’s keys, as strings and a boolean placeholder flag', async () => {
      const details = await createAdapter().detailsFor(params)

      expect(Object.keys(details).sort((a, b) => a.localeCompare(b))).toEqual([
        'cdpAudience',
        'clientId',
        'gatewayUrl',
        'placeholder',
        'scope',
        'tenantId',
        'tokenEndpoint'
      ])
      expect(typeof details.placeholder).toBe('boolean')

      for (const [key, value] of Object.entries(details)) {
        if (key !== 'placeholder') {
          expect(typeof value).toBe('string')
          expect(value.length).toBeGreaterThan(0)
        }
      }
    })

    test('detailsFor names the team on the gateway and gives the same answer twice', async () => {
      const adapter = createAdapter()
      const first = await adapter.detailsFor(params)

      expect(first.gatewayUrl).toContain('contract-team')
      await expect(adapter.detailsFor(params)).resolves.toEqual(first)
    })
  })
}
