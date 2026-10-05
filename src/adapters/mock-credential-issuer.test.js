import { mockCredentialIssuer } from '#/adapters/mock-credential-issuer.js'
import { describeCredentialIssuerContract } from '#/adapters/credential-issuer-contract.js'

describeCredentialIssuerContract('mock', () => mockCredentialIssuer)

describe('mockCredentialIssuer', () => {
  test('issue throws for a userId with the forced-failure test prefix', async () => {
    await expect(
      mockCredentialIssuer.issue({
        userId: 'test-fail-1',
        modelSlug: 'gpt-4o',
        tier: 'research'
      })
    ).rejects.toThrow('Mock issuer forced failure')
  })

  test('issue returns a shared externalId for a team credential, not per-model', async () => {
    const issued = await mockCredentialIssuer.issue({
      userId: 'user-1',
      modelSlug: 'gpt-4o',
      tier: 'team',
      teamId: 'team-1',
      environment: 'sandbox',
      credentialType: 'oauth'
    })

    expect(issued.externalId).toBe('team-team-1-sandbox')
    expect(issued.secret).toMatch(/^mock-oauth-/)
  })

  test('rotate on a team externalId keeps the oauth/subscription-key distinction', async () => {
    const rotated = await mockCredentialIssuer.rotate({
      externalId: 'team-team-1-sandbox',
      credentialType: 'oauth'
    })

    expect(rotated.secret).toMatch(/^mock-oauth-/)
  })
})
