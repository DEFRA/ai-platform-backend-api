export async function acquireLock(locker, resource, logger) {
  const lock = await locker.lock(resource)
  if (!lock) {
    if (logger) {
      logger.error(`Failed to acquire lock for ${resource}`)
    }
    return null
  }
  return lock
}

export async function requireLock(locker, resource) {
  const lock = await locker.lock(resource)
  if (!lock) {
    throw new Error(`Failed to acquire lock for ${resource}`)
  }
  return lock
}

/**
 * Acquires a lock, retrying while someone else holds it. `mongo-locks` never
 * waits - `lock()` returns null straight away - so serialising concurrent
 * callers (rather than failing the loser) needs an explicit retry.
 * @param {import('mongo-locks').LockManager} locker
 * @param {string} resource
 * @param {{attempts?: number, delayMs?: number}} [options]
 */
export async function acquireLockWithRetry(
  locker,
  resource,
  { attempts = 50, delayMs = 100 } = {}
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const lock = await locker.lock(resource)

    if (lock) {
      return lock
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  throw new Error(`Failed to acquire lock for ${resource}`)
}
