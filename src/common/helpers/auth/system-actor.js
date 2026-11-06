// Background work (the expiry scheduler and the maintenance sweep, an
// operation's own steps) has no request and so no token. It acts as this
// principal, never as the person whose credential or deployment it touches
// and never with a person's rights: it has no `oid`, no tenant and is no
// Platform Admin, and a token can never produce it (`identity.js` only makes
// `user` and `app` credentials).

/**
 * The principal recorded as `actorUserId` for the backend's own steps.
 */
export const SYSTEM_PRINCIPAL_ID = 'app:ai-platform-backend'

/**
 * The `role` an audit record carries for the backend's own steps.
 */
export const SYSTEM_ROLE = 'system'

export const TOKEN_SYSTEM = 'system'

/**
 * The credentials background work passes where a request would pass
 * `request.auth.credentials`.
 */
export const systemActor = Object.freeze({
  kind: TOKEN_SYSTEM,
  userId: SYSTEM_PRINCIPAL_ID,
  oid: null,
  tid: null,
  azp: null,
  uti: null,
  isPlatformAdmin: false
})
