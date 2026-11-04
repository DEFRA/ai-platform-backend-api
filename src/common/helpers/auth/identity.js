import { ACCESS, PLATFORM_ADMIN_ROLE } from '#/common/helpers/auth/access.js'

// Design E #portal: every token passes the common checks, which also decide
// its type; the checks that follow depend on that type.
export const MAX_LIFETIME_SECONDS = 2 * 60 * 60
export const CLOCK_SKEW_SECONDS = 60
export const PORTAL_SCOPE = 'Portal.Access'

export const TOKEN_USER = 'user'
export const TOKEN_APP = 'app'

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function hasLifetimeWithinCeiling({ iat, exp }, nowSeconds) {
  return (
    Number.isInteger(iat) &&
    Number.isInteger(exp) &&
    exp - iat <= MAX_LIFETIME_SECONDS &&
    iat <= nowSeconds + CLOCK_SKEW_SECONDS
  )
}

// A confidential client proved itself to Entra: `azpacr` 1 (secret) or 2
// (certificate or federated credential), never 0, never absent.
function isConfidentialClient({ azpacr }) {
  return azpacr !== undefined && azpacr !== null && String(azpacr) !== '0'
}

function passesCommonChecks(claims, { tenantId, clientId }, nowSeconds) {
  return (
    claims.tid === tenantId &&
    claims.ver === '2.0' &&
    claims.azp === clientId &&
    isConfidentialClient(claims) &&
    hasLifetimeWithinCeiling(claims, nowSeconds)
  )
}

/**
 * Which kind of token this is, from `idtyp` and `scp` together: `user` with
 * the portal scope is a person's, `app` with no `scp` is the frontend's own.
 * Any other combination, a missing `idtyp` included, is neither.
 * @param {object} claims
 * @returns {'user'|'app'|null}
 */
export function tokenTypeOf({ idtyp, scp }) {
  if (idtyp === 'user' && typeof scp === 'string') {
    return scp.split(' ').includes(PORTAL_SCOPE) ? TOKEN_USER : null
  }

  return idtyp === 'app' && scp === undefined ? TOKEN_APP : null
}

// `acct` is the user's account status in the tenant: 0 a member, 1 a guest.
function isTenantMember({ acct }) {
  return acct !== undefined && String(acct) === '0'
}

function personOf(claims) {
  return {
    oid: claims.oid,
    tid: claims.tid,
    azp: claims.azp,
    uti: claims.uti ?? null,
    email: typeof claims.email === 'string' ? claims.email : null,
    name: typeof claims.name === 'string' ? claims.name : null
  }
}

const INVALID = Object.freeze({ isValid: false })

async function delegatedIdentity(claims, request, access) {
  if (!isTenantMember(claims) || !GUID.test(claims.oid)) {
    return INVALID
  }

  const person = await request.db
    .collection('users')
    .findOne({ oid: claims.oid, tid: claims.tid }, { projection: { roles: 1 } })

  // Only the sign-in call may arrive before a person's record exists
  if (!person && access !== ACCESS.signIn) {
    return INVALID
  }

  return {
    isValid: true,
    credentials: {
      kind: TOKEN_USER,
      ...personOf(claims),
      userId: person?._id.toString() ?? null,
      isPlatformAdmin: person?.roles?.includes(PLATFORM_ADMIN_ROLE) ?? false
    }
  }
}

// The frontend's own token carries no person: `acct`, `oid` and the display
// claims are never read and no record is made. It reads the catalogue only.
function appIdentity(claims, access) {
  if (access !== ACCESS.catalogue) {
    return INVALID
  }

  return {
    isValid: true,
    credentials: {
      kind: TOKEN_APP,
      tid: claims.tid,
      azp: claims.azp,
      uti: claims.uti ?? null,
      userId: null,
      isPlatformAdmin: false
    }
  }
}

/**
 * The `validate` function of the portal's `@hapi/jwt` strategy. The library
 * has already checked the signature, `iss`, `aud`, `exp` and `nbf`; this adds
 * the rest of design E: `tid`, `ver`, `azp`, `azpacr`, the lifetime ceiling,
 * then by token type `acct`, `oid` and the person's record, or the route's
 * permission for the frontend's own token.
 *
 * Each route declares its access in `options.app.access`; a route that
 * declares none refuses every token.
 * @param {{tenantId: string, clientId: string, now?: () => number}} settings
 */
export function createIdentityValidator({
  tenantId,
  clientId,
  now = Date.now
}) {
  return async function validateIdentity(artifacts, request) {
    const claims = artifacts.decoded.payload
    const access = request.route.settings.app?.access

    if (
      !access ||
      !passesCommonChecks(claims, { tenantId, clientId }, now() / 1000)
    ) {
      return INVALID
    }

    switch (tokenTypeOf(claims)) {
      case TOKEN_USER:
        return delegatedIdentity(claims, request, access)
      case TOKEN_APP:
        return appIdentity(claims, access)
      default:
        return INVALID
    }
  }
}
