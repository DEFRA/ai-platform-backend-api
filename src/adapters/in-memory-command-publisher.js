import {
  assertPublishable,
  messageGroupId
} from '#/adapters/command-publisher.js'

const MINUTES_IN_MS = 60 * 1000
// The FIFO deduplication interval (SNS and SQS) is five minutes.
const DEDUP_WINDOW_MINUTES = 5
const FIVE_MINUTES_MS = DEDUP_WINDOW_MINUTES * MINUTES_IN_MS

/**
 * Creates an in-memory `CommandPublisher` that simulates an SNS FIFO topic
 * for local development and tests: a command whose `commandId` was accepted
 * within `dedupWindowMs` is accepted but not delivered again, and deliveries
 * keep their order within a message group (environment and team). A failing
 * `onDeliver` never fails the publish.
 * @param {{now?: () => number, dedupWindowMs?: number, onDeliver?: (command: object) => Promise<void>|void}} [options]
 * @returns {import('#/adapters/command-publisher.js').CommandPublisher & {published: object[], delivered: object[], setAvailable: (available: boolean) => void}}
 */
export function createInMemoryCommandPublisher({
  now = Date.now,
  dedupWindowMs = FIVE_MINUTES_MS,
  onDeliver
} = {}) {
  const published = []
  const delivered = []
  const acceptedAt = new Map()
  const groupTails = new Map()
  let available = true

  async function deliver(command) {
    delivered.push(command)

    try {
      await onDeliver?.(command)
    } catch {
      // A consumer failure is the consumer's: the queue already accepted it.
    }
  }

  return {
    published,
    delivered,

    setAvailable(value) {
      available = value
    },

    async publish(command) {
      assertPublishable(command)

      if (!available) {
        throw new Error('queue unavailable')
      }

      published.push(command)

      const acceptedTime = now()
      const previousAcceptance = acceptedAt.get(command.commandId)

      if (
        previousAcceptance !== undefined &&
        acceptedTime - previousAcceptance < dedupWindowMs
      ) {
        return
      }

      acceptedAt.set(command.commandId, acceptedTime)

      const group = messageGroupId(command)
      const delivery = (groupTails.get(group) ?? Promise.resolve()).then(() =>
        deliver(command)
      )

      groupTails.set(group, delivery)
      await delivery
    }
  }
}
