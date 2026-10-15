import { selectTenantResourceVerifier } from '#/adapters/tenant-resource-verifier-registry.js'
import { mockTenantResourceVerifier } from '#/adapters/mock-tenant-resource-verifier.js'

describe('#mockTenantResourceVerifier', () => {
  test('confirms any resources without calling Azure', async () => {
    await expect(
      mockTenantResourceVerifier.verify({
        environment: 'infradev',
        resources: null
      })
    ).resolves.toEqual({ verified: true })
  })
})

describe('#selectTenantResourceVerifier', () => {
  const mock = { verify: async () => ({ verified: true }) }
  const live = { verify: async () => ({ verified: false }) }

  test('selects the verifier for the provisioning mode', () => {
    expect(selectTenantResourceVerifier({ mock, live }, 'mock')).toBe(mock)
    expect(selectTenantResourceVerifier({ mock, live }, 'live')).toBe(live)
  })

  test('refuses a mode it has no verifier for', () => {
    expect(() => selectTenantResourceVerifier({ mock }, 'live')).toThrow(
      'No tenant resource verifier for provisioning mode "live"'
    )
  })
})
