const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Entra IDs are lowercase GUIDs; a token's claim is compared with them exactly.
function guidOrNull(value) {
  if (value !== null && !GUID.test(value)) {
    throw new Error('must be a GUID')
  }
}

/**
 * The `portalAuth` section of the convict schema: the Entra access tokens the
 * backend accepts (design E #portal). Nothing turns validation off: the mock
 * issuer is a different key source, checked the same way. It lives apart from
 * `config.js` to keep that file short.
 */
export const portalAuthConfigSchema = {
  tenantId: {
    doc: 'The Defra Entra tenant: the only tenant whose v2 tokens are accepted',
    format: guidOrNull,
    nullable: true,
    default: null,
    env: 'PORTAL_AUTH_TENANT_ID'
  },
  audience: {
    doc: "The client ID of this instance's api-aip-portal registration, the `aud` every token must carry",
    format: guidOrNull,
    nullable: true,
    default: null,
    env: 'PORTAL_AUTH_AUDIENCE'
  },
  clientId: {
    doc: "The client ID of this instance's frontend registration, the `azp` every token must carry",
    format: guidOrNull,
    nullable: true,
    default: null,
    env: 'PORTAL_AUTH_CLIENT_ID'
  },
  mockIssuerUrl: {
    doc: "Local development only: the frontend's mock OpenID provider, which becomes the token issuer and serves the signing keys at /jwks. Refused in production",
    format: String,
    nullable: true,
    default: null,
    env: 'PORTAL_AUTH_MOCK_ISSUER_URL'
  }
}
