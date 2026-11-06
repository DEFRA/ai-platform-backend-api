import {
  assertNotRevoked,
  credentialLockName,
  environmentOf,
  externalGatewaySubscriptionIdOf,
  researchEnvironmentFilter,
  issuanceAuditActor,
  ROLE_OWNER
} from '#/services/credential-common.js'
import { systemActor } from '#/common/helpers/auth/system-actor.js'

describe('#credential-common', () => {
  describe('environmentOf', () => {
    test('reads the environment the credential was issued in', () => {
      expect(environmentOf({ tier: 'research', environment: 'dev' })).toBe(
        'dev'
      )
    })

    test('counts a research credential with no environment as sandbox', () => {
      expect(environmentOf({ tier: 'research' })).toBe('sandbox')
    })

    test('leaves a team credential with no environment without one', () => {
      expect(environmentOf({ tier: 'team' })).toBeNull()
    })
  })

  describe('researchEnvironmentFilter', () => {
    test('matches the environment exactly', () => {
      expect(researchEnvironmentFilter('dev')).toEqual({ environment: 'dev' })
    })

    test('counts a document with no environment as the legacy sandbox one', () => {
      expect(researchEnvironmentFilter('sandbox').$or).toHaveLength(3)
    })
  })

  test('externalGatewaySubscriptionIdOf falls back to the pre-rename field', () => {
    expect(externalGatewaySubscriptionIdOf({ apimSubscriptionId: 'old' })).toBe(
      'old'
    )
    expect(
      externalGatewaySubscriptionIdOf({
        externalGatewaySubscriptionId: 'new',
        apimSubscriptionId: 'old'
      })
    ).toBe('new')
  })

  test('credentialLockName uses the canonical hex form of an id', () => {
    const upper = 'ABCDEF0123456789ABCDEF01'

    expect(credentialLockName(upper)).toBe(
      credentialLockName(upper.toLowerCase())
    )
    expect(credentialLockName('not-an-id')).toBe('credential:not-an-id')
  })

  describe('assertNotRevoked', () => {
    test('refuses a revoked credential as credential-revoked', () => {
      expect(() => assertNotRevoked({ status: 'revoked' })).toThrow(
        'Credential has been revoked'
      )
    })

    test('lets any other credential through', () => {
      expect(() => assertNotRevoked({ status: 'active' })).not.toThrow()
    })
  })

  describe('issuanceAuditActor', () => {
    test('names the requester acting as owner', () => {
      const actor = { userId: 'u1' }

      expect(issuanceAuditActor(actor)).toEqual({ actor, role: ROLE_OWNER })
    })

    test('names the system when no request issued the credential', () => {
      expect(issuanceAuditActor(null)).toEqual({ actor: systemActor })
    })
  })
})
