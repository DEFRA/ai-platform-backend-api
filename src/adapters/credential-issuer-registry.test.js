import { createCredentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'

describe('#createCredentialIssuerRegistry', () => {
  const mockIssuer = { id: 'mock-issuer' }
  const azureIssuer = { id: 'azure-issuer' }
  const issuersByKey = { mock: mockIssuer, azure: azureIssuer }

  test('forModel resolves the default issuerKey when the model has none of its own', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'azure')

    expect(registry.forModel({ slug: 'gpt-4o' })).toEqual({
      issuerKey: 'azure',
      issuer: azureIssuer
    })
  })

  test('forModel prefers a model-level issuerKey override over the default', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'mock')

    expect(registry.forModel({ slug: 'gpt-4o', issuerKey: 'azure' })).toEqual({
      issuerKey: 'azure',
      issuer: azureIssuer
    })
  })

  test('forCredential resolves by the stored issuerKey, regardless of the default', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'azure')

    expect(registry.forCredential({ issuerKey: 'mock' })).toEqual({
      issuerKey: 'mock',
      issuer: mockIssuer
    })
  })

  test('forCredential falls back to "mock" for a legacy credential with no issuerKey', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'azure')

    expect(registry.forCredential({})).toEqual({
      issuerKey: 'mock',
      issuer: mockIssuer
    })
  })

  test('throws for an unregistered issuerKey', () => {
    const registry = createCredentialIssuerRegistry(issuersByKey, 'azure')

    expect(() => registry.forCredential({ issuerKey: 'bedrock' })).toThrow(
      'No credential issuer registered for issuerKey "bedrock"'
    )
  })
})
