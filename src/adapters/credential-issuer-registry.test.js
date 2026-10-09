import { createCredentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'

describe('#createCredentialIssuerRegistry', () => {
  const mockIssuer = { id: 'mock-issuer' }
  const azureIssuer = { id: 'azure-issuer' }
  const issuersByKey = {
    mock: mockIssuer,
    'azure-apim': azureIssuer,
    azure: azureIssuer
  }

  test('forModel falls back to azure-apim for a model with no adapter', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'live')

    expect(registry.forModel({ slug: 'gpt-4o' })).toEqual({
      issuerKey: 'azure-apim',
      issuer: azureIssuer
    })
  })

  test('forModel resolves the issuer registered for the model gateway', () => {
    const otherGatewayIssuer = { id: 'other-gateway-issuer' }
    const registry = createCredentialIssuerRegistry(
      { ...issuersByKey, 'aws-apigw': otherGatewayIssuer },
      'live'
    )

    expect(
      registry.forModel({ slug: 'gpt-4o', gateway: 'azure-apim' })
    ).toEqual({ issuerKey: 'azure-apim', issuer: azureIssuer })
    expect(registry.forModel({ slug: 'claude', gateway: 'aws-apigw' })).toEqual(
      { issuerKey: 'aws-apigw', issuer: otherGatewayIssuer }
    )
  })

  test('forModel always resolves the mock issuer in mock mode, whatever the model gateway', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'mock')

    expect(
      registry.forModel({ slug: 'gpt-4o', gateway: 'azure-apim' })
    ).toEqual({ issuerKey: 'mock', issuer: mockIssuer })
  })

  test('forModel resolves the mock issuer only for a tier listed in mockTiers, even in live mode', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'live', [
      'team'
    ])
    const model = { slug: 'gpt-4o', gateway: 'azure-apim' }

    expect(registry.forModel(model, 'team')).toEqual({
      issuerKey: 'mock',
      issuer: mockIssuer
    })
    expect(registry.forModel(model, 'research')).toEqual({
      issuerKey: 'azure-apim',
      issuer: azureIssuer
    })
  })

  test('forModel throws a coded error for a gateway that is not enabled', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'live')

    expect(() =>
      registry.forModel({ slug: 'claude', gateway: 'aws-apigw' })
    ).toThrow(
      expect.objectContaining({
        code: 'gateway-not-enabled',
        message: 'No credential issuer registered for issuerKey "aws-apigw"'
      })
    )
  })

  test('forCredential resolves by the stored issuerKey, regardless of the mode', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'live')

    expect(registry.forCredential({ issuerKey: 'mock' })).toEqual({
      issuerKey: 'mock',
      issuer: mockIssuer
    })
    expect(registry.forCredential({ issuerKey: 'azure' })).toEqual({
      issuerKey: 'azure',
      issuer: azureIssuer
    })
  })

  test('forCredential falls back to "mock" for a legacy credential with no issuerKey', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'live')

    expect(registry.forCredential({})).toEqual({
      issuerKey: 'mock',
      issuer: mockIssuer
    })
  })

  test('throws for an unregistered issuerKey', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'live')

    expect(() => registry.forCredential({ issuerKey: 'bedrock' })).toThrow(
      'No credential issuer registered for issuerKey "bedrock"'
    )
  })
})
