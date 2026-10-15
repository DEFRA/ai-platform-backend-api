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

  test('issue returns a shared OAuth client secret for a team credential, not per-model', async () => {
    const issued = await mockCredentialIssuer.issue({
      userId: 'user-1',
      modelSlug: 'gpt-4o',
      tier: 'team',
      teamId: 'team-1',
      environment: 'sandbox'
    })

    expect(issued.externalId).toBe('team-team-1-sandbox')
    expect(issued.secret).toMatch(/^mock-oauth-/)
    expect(issued.keyHint).toBe(issued.secret.slice(-4))
  })

  test('rotate keeps a team credential an OAuth client secret and a research one a key', async () => {
    const team = await mockCredentialIssuer.rotate({
      externalId: 'team-team-1-sandbox'
    })
    const research = await mockCredentialIssuer.rotate({
      externalId: 'research-user-1-gpt-4o'
    })

    expect(team.secret).toMatch(/^mock-oauth-/)
    expect(research.secret).toMatch(/^mock_/)
  })
})
