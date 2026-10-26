const COLLECTION = 'environmentControls'
const DUPLICATE_KEY = 11000

/**
 * The environment controls (plan 5, "Pause"): `environmentControls
 * {_id: environment, paused, runId, runStartedAt, requestedBy}`, advisory
 * only. The workflows' own read of `AIP_PAUSED` is authoritative, so a lost
 * `paused` event can never let an automatic write or retry through; this
 * record only spares a dispatch that would be refused.
 * @param {{db: import('mongodb').Db, corroborator: {corroboratePause: Function}, logger?: import('pino').Logger}} deps
 */
export function createEnvironmentControls({ db, corroborator, logger }) {
  const controls = db.collection(COLLECTION)

  /**
   * The control for an environment; an environment never paused has none.
   * @param {string} environment
   * @returns {Promise<{_id: string, paused: boolean, runId?: number, runStartedAt?: string, requestedBy?: string}>}
   */
  async function get(environment) {
    return (
      (await controls.findOne({ _id: environment })) ?? {
        _id: environment,
        paused: false
      }
    )
  }

  /**
   * @param {string} environment
   * @returns {Promise<boolean>}
   */
  async function isPaused(environment) {
    return (await get(environment)).paused
  }

  /**
   * Applies a `paused` or `resumed` event when it is corroborated (a
   * successful `pause.yml` run on main by admins) and later than the one
   * held: by the run's start time, the run ID breaking a tie, because run IDs
   * are not documented as ordered. An older or repeated event changes
   * nothing, whatever order they arrive in.
   * @param {object} event
   * @returns {Promise<{outcome: 'applied'|'stale'|'uncorroborated', paused?: boolean}>}
   */
  async function apply(event) {
    const verdict = await corroborator.corroboratePause(event)

    if (!verdict.ok) {
      logger?.warn(
        { eventId: event.eventId, reason: verdict.reason },
        'A pause event was not corroborated, dropped'
      )

      return { outcome: 'uncorroborated' }
    }

    const runStartedAt = verdict.run.runStartedAt
    const paused = event.status === 'paused'

    async function write(upsert) {
      const { modifiedCount, upsertedCount } = await controls.updateOne(
        {
          _id: event.environment,
          $or: [
            { runStartedAt: { $lt: runStartedAt } },
            { runStartedAt, runId: { $lt: event.runId } }
          ]
        },
        {
          $set: {
            paused,
            runId: event.runId,
            runStartedAt,
            requestedBy: event.requestedBy
          }
        },
        { upsert }
      )

      return modifiedCount + upsertedCount > 0
    }

    let applied

    try {
      applied = await write(true)
    } catch (error) {
      if (error.code !== DUPLICATE_KEY) {
        throw error
      }

      // The upsert met a control already there: either a newer one (this
      // event is the stale one) or an older one a concurrent first write
      // inserted, which this event must still replace. The filter decides.
      applied = await write(false)
    }

    return applied ? { outcome: 'applied', paused } : { outcome: 'stale' }
  }

  return { get, isPaused, apply }
}
