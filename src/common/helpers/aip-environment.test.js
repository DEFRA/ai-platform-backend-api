import { resolveAipEnvironment } from '#/common/helpers/aip-environment.js'

const infradev = {
  subscriptionId: '00000000-0000-0000-0000-000000000000',
  resourceGroup: 'rg-placeholder',
  apimName: 'apim-placeholder',
  foundryAccounts: ['aif-placeholder'],
  tenantsVault: 'kv-placeholder'
}

describe('#resolveAipEnvironment', () => {
  test('returns the named environment', () => {
    expect(resolveAipEnvironment('infradev', { infradev })).toBe(infradev)
  })

  test.each([undefined, null, '', 'sandbox'])(
    'fails closed with a stable code for %j',
    (name) => {
      expect(() => resolveAipEnvironment(name, { infradev })).toThrow(
        expect.objectContaining({ code: 'environment-not-configured' })
      )
    }
  )

  test('does not resolve an inherited property as an environment', () => {
    expect(() => resolveAipEnvironment('constructor', {})).toThrow(
      expect.objectContaining({ code: 'environment-not-configured' })
    )
  })
})
