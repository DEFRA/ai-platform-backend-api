import { Consumer } from 'sqs-consumer'

import { drain } from '#/common/helpers/drain.js'

const DEFAULT_ERROR_PAUSE_MS = 10000

/**
 * The inbound adapter of the events queue (plan 5, DD14): `sqs-consumer` 15
 * with `batchSize: 1` and `suppressFifoWarning: true` (the library does not
 * test FIFO, so the FIFO behaviour is proved by the Floci tests), long
 * polling, and a handler timeout under the queue's 60 s visibility timeout.
 * A message that is not JSON is logged and acknowledged; a handler error
 * leaves the message on the queue, so it is redelivered and, after three
 * receives, reaches the dead-letter queue.
 * With `alwaysAcknowledge` the library deletes a message once the handler
 * resolves, so the handler returns nothing; a thrown error leaves the
 * message on the queue.
 * @param {{handle: (event: unknown) => Promise<unknown>}} handler
 * @param {import('pino').Logger} [logger]
 * @returns {(message: {Body?: string, MessageId?: string}) => Promise<void>}
 */
export function createMessageHandler(handler, logger) {
  return async function handleMessage(message) {
    let event

    try {
      event = JSON.parse(message.Body)
    } catch {
      logger?.warn(
        { messageId: message.MessageId },
        'A message that is not JSON was dropped'
      )

      return
    }

    await handler.handle(event)
  }
}

/**
 * Creates the consumer of the events queue.
 * @param {object} deps
 * @param {string} deps.queueUrl
 * @param {import('@aws-sdk/client-sqs').SQSClient} deps.sqs
 * @param {{handle: (event: unknown) => Promise<unknown>}} deps.handler
 * @param {{handlerTimeoutMs: number, waitTimeSeconds: number, errorPauseMs?: number, drainTimeoutMs?: number}} deps.settings
 * @param {import('pino').Logger} [deps.logger]
 * @returns {{start: () => void, stop: (options?: {abort?: boolean}) => Promise<void>, isRunning: boolean}}
 */
export function createEventsConsumer({
  queueUrl,
  sqs,
  handler,
  settings,
  logger
}) {
  const handleMessage = createMessageHandler(handler, logger)
  // The handlers running now, so a stop can wait for them before the
  // database they write to is closed.
  const inFlight = new Set()
  const consumer = Consumer.create({
    queueUrl,
    sqs,
    batchSize: 1,
    suppressFifoWarning: true,
    alwaysAcknowledge: true,
    waitTimeSeconds: settings.waitTimeSeconds,
    visibilityTimeout: 60,
    // After a failed receive the library waits this long before it polls again.
    authenticationErrorTimeout: settings.errorPauseMs ?? DEFAULT_ERROR_PAUSE_MS,
    handleMessageTimeout: settings.handlerTimeoutMs,
    handleMessage(message) {
      const running = handleMessage(message)

      inFlight.add(running)
      running
        .catch(() => {})
        .finally(() => {
          inFlight.delete(running)
        })

      return running
    }
  })

  // The message ID and the failure only: a message can hold a document.
  consumer.on('error', (error) => {
    logger?.error({ message: error.message }, 'The events queue failed')
  })
  // The library wraps a handler failure; the cause is the useful text.
  consumer.on('processing_error', (error, message) => {
    logger?.warn(
      {
        messageId: message?.MessageId,
        message: (error.cause ?? error).message
      },
      'An event could not be handled and will be redelivered'
    )
  })
  consumer.on('timeout_error', (error, message) => {
    logger?.warn(
      { messageId: message?.MessageId, message: error.message },
      'An event timed out and will be redelivered'
    )
  })

  return {
    start() {
      consumer.start()
    },
    /**
     * Stops polling at once, then waits for a handler already running, up to
     * `drainTimeoutMs` (the sweeps' bound by default), so the database is not
     * closed under it; a stuck handler never holds shutdown past the bound,
     * and its message is redelivered. With `abort` the SDK requests in flight
     * are cancelled too.
     * @param {{abort?: boolean}} [options]
     * @returns {Promise<void>}
     */
    stop(options) {
      consumer.stop(options)

      return drain(inFlight, settings.drainTimeoutMs)
    },
    get isRunning() {
      return consumer.status.isRunning
    }
  }
}
