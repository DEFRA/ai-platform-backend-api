/**
 * Where an application runs.
 */
export const FEDERATION_HOSTS = Object.freeze({ CDP: 'cdp', AZURE: 'azure' })

/**
 * The statuses an application shows.
 */
export const FEDERATION_STATUS = Object.freeze({
  SETTING_UP: 'setting-up',
  READY: 'ready',
  REMOVING: 'removing',
  FAILED: 'failed',
  REMOVED: 'removed'
})

/**
 * The most applications one team's registration holds in an environment
 * (`team.schema.json`: `oauth.federations` has at most 20).
 */
export const MAX_FEDERATIONS = 20
