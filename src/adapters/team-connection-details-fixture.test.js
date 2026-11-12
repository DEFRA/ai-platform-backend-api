import { createFixtureConnectionDetails } from '#/adapters/team-connection-details-fixture.js'
import { describeTeamConnectionDetailsContract } from '#/adapters/team-connection-details-contract.js'

describeTeamConnectionDetailsContract('fixture', createFixtureConnectionDetails)

describe('#createFixtureConnectionDetails', () => {
  const adapter = createFixtureConnectionDetails()

  test('is flagged a placeholder, so a page says the values are made up', async () => {
    const details = await adapter.detailsFor({
      team: { slug: 'alpha' },
      environment: 'infradev'
    })

    expect(details.placeholder).toBe(true)
  })

  test('gives each team and environment its own client ID, a GUID, and builds the scope from it', async () => {
    const infradev = await adapter.detailsFor({
      team: { slug: 'alpha' },
      environment: 'infradev'
    })
    const sandbox = await adapter.detailsFor({
      team: { slug: 'alpha' },
      environment: 'sandbox'
    })
    const beta = await adapter.detailsFor({
      team: { slug: 'beta' },
      environment: 'infradev'
    })

    expect(infradev.clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    expect(
      new Set([infradev.clientId, sandbox.clientId, beta.clientId]).size
    ).toBe(3)
    expect(infradev.scope).toBe(`api://${infradev.clientId}/.default`)
  })

  test('uses a fixture tenant when none is configured', async () => {
    const { config } = await import('#/config.js')
    const configured = config.get('portalAuth.tenantId')

    config.set('portalAuth.tenantId', null)

    try {
      const details = await adapter.detailsFor({
        team: { slug: 'alpha' },
        environment: 'infradev'
      })

      expect(details.tenantId).toBe('00000000-0000-4000-8000-000000000000')
    } finally {
      config.set('portalAuth.tenantId', configured)
    }
  })

  test('points at the Defra tenant’s token endpoint and the mock gateway’s team path', async () => {
    const details = await adapter.detailsFor({
      team: { slug: 'alpha' },
      environment: 'infradev'
    })

    expect(details.tokenEndpoint).toBe(
      `https://login.microsoftonline.com/${details.tenantId}/oauth2/v2.0/token`
    )
    expect(details.gatewayUrl).toBe(
      'https://mock-gateway.ai-platform.defra.gov.uk/alpha'
    )
    expect(details.cdpAudience).toBe('api://AzureADTokenExchange')
  })
})
