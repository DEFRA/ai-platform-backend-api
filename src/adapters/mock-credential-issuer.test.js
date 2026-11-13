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

  test('issue names a secret an Admin adds by its credential id, so each is its own and differs from the automatic one', async () => {
    const base = {
      userId: 'user-1',
      modelSlug: 'gpt-4o',
      tier: 'team',
      teamId: 'team-1',
      environment: 'sandbox'
    }
    const automatic = await mockCredentialIssuer.issue(base)
    const first = await mockCredentialIssuer.issue({
      ...base,
      credentialId: 'cred-1'
    })
    const second = await mockCredentialIssuer.issue({
      ...base,
      credentialId: 'cred-2'
    })

    expect(automatic.externalId).toBe('team-team-1-sandbox')
    expect(first.externalId).toBe('team-team-1-sandbox-cred-1')
    expect(second.externalId).toBe('team-team-1-sandbox-cred-2')
    expect(
      new Set([automatic.externalId, first.externalId, second.externalId]).size
    ).toBe(3)
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
