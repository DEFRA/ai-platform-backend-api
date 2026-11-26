import { convictValidateAipEnvironments } from './validate-aip-environments.js'

const infradev = {
  subscriptionId: '00000000-0000-0000-0000-000000000000',
  resourceGroup: 'rg-placeholder',
  apimName: 'apim-placeholder',
  foundryAccounts: ['aif-placeholder'],
  tenantsVault: 'kv-placeholder'
}

describe('#convictValidateAipEnvironments', () => {
  test('accepts environments keyed by name with every setting', () => {
    expect(() =>
      convictValidateAipEnvironments.validate({ infradev })
    ).not.toThrow()
  })

  test('accepts no environments', () => {
    expect(() => convictValidateAipEnvironments.validate({})).not.toThrow()
  })

  test('rejects an environment missing its Foundry accounts', () => {
    const { foundryAccounts, ...withoutAccounts } = infradev

    expect(() =>
      convictValidateAipEnvironments.validate({ infradev: withoutAccounts })
    ).toThrow(/foundryAccounts/)
  })

  test('rejects an unknown setting', () => {
    expect(() =>
      convictValidateAipEnvironments.validate({
        infradev: { ...infradev, location: 'uksouth' }
      })
    ).toThrow(/location/)
  })

  test('accepts a Log Analytics workspace, which is optional', () => {
    expect(() =>
      convictValidateAipEnvironments.validate({
        infradev: { ...infradev, logAnalyticsWorkspace: 'SNDAIPAPPLW1401' }
      })
    ).not.toThrow()
  })

  test.each(['a/../b', 'law test', 'x?y=1', 'ab', '-lead-ing-'])(
    'rejects the workspace %j, which would reach a different ARM path',
    (workspace) => {
      expect(() =>
        convictValidateAipEnvironments.validate({
          infradev: { ...infradev, logAnalyticsWorkspace: workspace }
        })
      ).toThrow(/logAnalyticsWorkspace/)
    }
  )

  test('parses the environment variable as JSON', () => {
    expect(
      convictValidateAipEnvironments.coerce(JSON.stringify({ infradev }))
    ).toEqual({ infradev })
  })
})
