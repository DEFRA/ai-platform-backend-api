import { Consumer } from 'sqs-consumer'

const DEFAULT_ERROR_PAUSE_MS = 10000

/**
 * The inbound adapter of the events queue (plan 5, DD14): `sqs-consumer` 15
 * with `batchSize: 1` and `suppressFifoWarning: true` (the library does not
 * test FIFO, so the FIFO behaviour is proved by the Floci tests), long
 * polling, and a handler timeout under the queue's 60 s visibility timeout.
 * A message that is not JSON is logged and acknowledged; a handler error
 * leaves the message on the queue, so it is redelivered and, after three
 * receives, reaches the dead-letter queue.
 * @param {{handle: (event: unknown) => Promise<unknown>}} handler
 * @param {import('pino').Logger} [logger]
 * `sqs-consumer` deletes a message only when the handler returns it, so the
 * message is returned once it is handled or dropped; a thrown error returns
 * nothing and leaves the message on the queue.
 * @param {{handle: (event: unknown) => Promise<unknown>}} handler
 * @param {import('pino').Logger} [logger]
 * @returns {(message: {Body?: string, MessageId?: string}) => Promise<{Body?: string, MessageId?: string}>}
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

      return message
    }

    await handler.handle(event)

    return message
  }
}

/**
 * Creates the consumer of the events queue.
 * @param {object} deps
 * @param {string} deps.queueUrl
 * @param {import('@aws-sdk/client-sqs').SQSClient} deps.sqs
 * @param {{handle: (event: unknown) => Promise<unknown>}} deps.handler
 * @param {{handlerTimeoutMs: number, waitTimeSeconds: number, errorPauseMs?: number}} deps.settings
 * @param {import('pino').Logger} [deps.logger]
 * @returns {{start: () => void, stop: () => void, isRunning: boolean}}
 */
export function createEventsConsumer({
  queueUrl,
  sqs,
  handler,
  settings,
  logger
}) {
  const consumer = Consumer.create({
    queueUrl,
    sqs,
    batchSize: 1,
    suppressFifoWarning: true,
    waitTimeSeconds: settings.waitTimeSeconds,
    visibilityTimeout: 60,
    // After a failed receive the library waits this long before it polls again.
    authenticationErrorTimeout: settings.errorPauseMs ?? DEFAULT_ERROR_PAUSE_MS,
    handleMessageTimeout: settings.handlerTimeoutMs,
    handleMessage: createMessageHandler(handler, logger)
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
     * Stops polling. With `abort` the SDK requests in flight are cancelled
     * too, so a message being processed is redelivered rather than awaited.
     * @param {{abort?: boolean}} [options]
     */
    stop(options) {
      consumer.stop(options)
    },
    get isRunning() {
      return consumer.status.isRunning
    }
  }
}
