/**
 * Shared `CredentialIssuer` contract suite, run against every adapter (mock
 * and the nocked Azure APIM adapter) so a new provider's Liskov substitution
 * is enforced by an executable test, not asserted in prose. Asserts the
 * output shape every adapter must produce for the same inputs: `keyHint` is
 * always the last four characters of the secret, `revoke` is idempotent,
 * and every method echoes back the `externalId` it was given.
 * @param {string} gatewayName
 * @param {() => import('./credential-issuer.js').CredentialIssuer} createIssuer
 * @param {{issueParams?: object}} [options]
 */
export function describeCredentialIssuerContract(
  gatewayName,
  createIssuer,
  options = {}
) {
  const issueParams = {
    userId: 'contract-user-1',
    modelSlug: 'gpt-4o',
    tier: 'research',
    teamId: null,
    environment: null,
    credentialType: 'subscription-key',
    ...options.issueParams
  }

  describe(`CredentialIssuer contract: ${gatewayName}`, () => {
    test('issue returns an externalId, a secret, a matching keyHint and an expiresAt', async () => {
      const issued = await createIssuer().issue(issueParams)

      expect(issued.externalId).toEqual(expect.any(String))
      expect(issued.secret).toEqual(expect.any(String))
      expect(issued.keyHint).toBe(issued.secret.slice(-4))
      expect(issued.expiresAt).toEqual(expect.any(String))
    })

    test('rotate returns a new secret for the same externalId, with a matching keyHint', async () => {
      const issuer = createIssuer()
      const issued = await issuer.issue(issueParams)
      const rotated = await issuer.rotate({
        externalId: issued.externalId,
        credentialType: issueParams.credentialType
      })

      expect(rotated.externalId).toBe(issued.externalId)
      expect(rotated.keyHint).toBe(rotated.secret.slice(-4))
    })

    test('renew and suspend echo the externalId they were given', async () => {
      const issuer = createIssuer()
      const issued = await issuer.issue(issueParams)

      await expect(
        issuer.renew({
          externalId: issued.externalId,
          expiresAt: new Date(Date.now() + 86400000).toISOString()
        })
      ).resolves.toMatchObject({ externalId: issued.externalId })
      await expect(
        issuer.suspend({ externalId: issued.externalId })
      ).resolves.toMatchObject({ externalId: issued.externalId })
    })

    test('revoke is idempotent - calling it twice does not throw', async () => {
      const issuer = createIssuer()
      const issued = await issuer.issue(issueParams)

      await expect(
        issuer.revoke({ externalId: issued.externalId })
      ).resolves.toMatchObject({ externalId: issued.externalId })
      await expect(
        issuer.revoke({ externalId: issued.externalId })
      ).resolves.toMatchObject({ externalId: issued.externalId })
    })
  })
}
