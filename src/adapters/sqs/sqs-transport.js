import { config } from '#/config.js'
import { createGithubRunReader } from '#/adapters/github/github-run-reader.js'
import {
  createSqsClient,
  createSqsCommandPublisher
} from '#/adapters/sqs/sqs-command-publisher.js'
import { createEventsConsumer } from '#/operations/events-consumer.js'

/**
 * The SQS transport (the `sqs` orchestrator): commands go to the GitOps
 * commands queue, the events consumer reads the events queue into the events
 * handler, and a failure is corroborated against GitHub with the run reader.
 * Nothing is read from configuration until the transport is created.
 * @param {{handle: (event: unknown) => Promise<unknown>, logger?: import('pino').Logger}} deps
 * @param {object} [overrides] - the parts to replace, for a test
 */
export function createSqsTransport(
  { handle, logger },
  {
    settings = {
      commandsQueueUrl: config.get('gitops.commandsQueueUrl'),
      eventsQueueUrl: config.get('gitops.eventsQueueUrl'),
      endpoint: config.get('gitops.awsSqsEndpoint') ?? undefined,
      region: config.get('gitops.awsRegion'),
      handlerTimeoutMs: config.get('gitops.handlerTimeoutMs'),
      waitTimeSeconds: config.get('gitops.sqsWaitTimeSeconds')
    },
    createClient = createSqsClient,
    createPublisher = createSqsCommandPublisher,
    createConsumer = createEventsConsumer,
    createRunReader = createGithubRunReader
  } = {}
) {
  const client = createClient({
    endpoint: settings.endpoint,
    region: settings.region
  })
  const consumer = createConsumer({
    queueUrl: settings.eventsQueueUrl,
    sqs: client,
    handler: { handle },
    settings: {
      handlerTimeoutMs: settings.handlerTimeoutMs,
      waitTimeSeconds: settings.waitTimeSeconds
    },
    logger
  })

  return {
    publisher: createPublisher({
      client,
      queueUrl: settings.commandsQueueUrl
    }),
    runReader: createRunReader(),
    start() {
      consumer.start()
    },
    // The message being handled is redelivered rather than awaited.
    async stop() {
      consumer.stop({ abort: true })
    }
  }
}
