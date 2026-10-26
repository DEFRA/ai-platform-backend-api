import {
  claimOutboxEntry,
  findOperation,
  findPendingOutbox,
  markOutboxPublished
} from '#/operations/operation-repository.js'
import { buildCommand } from '#/operations/operation-factory.js'

/**
 * The relay of the transactional outbox (plan 5, DD2): an operation's
 * commands are written in the same single-document write as its state, then
 * published here, right after the write and again by the sweep, so no
 * request is lost to an SQS outage. An instance claims an entry by
 * compare-and-set before it publishes, so two never publish one entry
 * together; a republish keeps the entry's command ID, which SQS
 * deduplicates for five minutes.
 * @param {{db: import('mongodb').Db, publisher: import('#/adapters/command-publisher.js').CommandPublisher, settings: {outboxLeaseMs: number}, logger?: import('pino').Logger}} deps
 */
export function createOutboxRelay({ db, publisher, settings, logger }) {
  async function publishEntry(operation, entry) {
    const claimed = await claimOutboxEntry(db, {
      operationId: operation._id,
      commandId: entry.commandId,
      leaseMs: settings.outboxLeaseMs
    })

    if (!claimed) {
      return false
    }

    try {
      await publisher.publish(buildCommand(operation, entry))
    } catch (error) {
      // The claim lapses and the sweep tries again. IDs and the failure
      // code only: a command can hold a whole desired-state document.
      logger?.warn(
        {
          operationId: operation._id,
          commandId: entry.commandId,
          code: error.code ?? error.name
        },
        'A command could not be published, the sweep will retry'
      )

      return false
    }

    await markOutboxPublished(db, {
      operationId: operation._id,
      commandId: entry.commandId
    })

    return true
  }

  /**
   * Publishes every unpublished entry of one operation.
   * @param {string} operationId
   * @returns {Promise<number>} How many it published.
   */
  async function publishOperation(operationId) {
    const operation = await findOperation(db, operationId)
    let published = 0

    const unpublished = (operation?.outbox ?? []).filter(
      ({ publishedAt }) => !publishedAt
    )

    // In order: an operation's commands are delivered in the order written.
    for (const entry of unpublished) {
      const sent = await publishEntry(operation, entry) // NOSONAR: sequential by design, see above

      if (sent) {
        published += 1
      }
    }

    return published
  }

  /**
   * Publishes the entries no request path published (the sweep, every
   * `GITOPS_OUTBOX_SWEEP_MS`).
   * @returns {Promise<number>} How many it published.
   */
  async function sweep() {
    let published = 0

    // One operation at a time, so a backlog after an outage reaches SQS at a
    // bounded rate.
    for (const { _id } of await findPendingOutbox(db)) {
      published += await publishOperation(_id) // NOSONAR: sequential by design, see above
    }

    return published
  }

  return { publishOperation, sweep }
}
