import { config } from '#/config.js'
import { createGithubRunReader } from '#/adapters/github/github-run-reader.js'
import { createSqsClient } from '#/adapters/sqs/sqs-client.js'
import { createSnsClient } from '#/adapters/sns/sns-client.js'
import { createSnsCommandPublisher } from '#/adapters/sns/sns-command-publisher.js'
import { createEventsConsumer } from '#/operations/events-consumer.js'

/**
 * The SQS transport (the `sqs` orchestrator): commands are published to the
 * GitOps commands SNS topic the backend owns (the worker's own queue is
 * subscribed to it), the events consumer reads the events queue the backend
 * owns into the events handler, and a failure is corroborated against GitHub
 * with the run reader. Nothing is read from configuration until the transport
 * is created.
 * @param {{handle: (event: unknown) => Promise<unknown>, logger?: import('pino').Logger}} deps
 * @param {object} [overrides] - the parts to replace, for a test
 */
export function createSqsTransport(
  { handle, logger },
  {
    settings = {
      commandsTopicArn: config.get('gitops.commandsTopicArn'),
      eventsQueueUrl: config.get('gitops.eventsQueueUrl'),
      sqsEndpoint: config.get('gitops.awsSqsEndpoint') ?? undefined,
      snsEndpoint: config.get('gitops.awsSnsEndpoint') ?? undefined,
      region: config.get('gitops.awsRegion'),
      handlerTimeoutMs: config.get('gitops.handlerTimeoutMs'),
      waitTimeSeconds: config.get('gitops.sqsWaitTimeSeconds')
    },
    createClient = createSqsClient,
    createTopicClient = createSnsClient,
    createPublisher = createSnsCommandPublisher,
    createConsumer = createEventsConsumer,
    createRunReader = createGithubRunReader
  } = {}
) {
  const client = createClient({
    endpoint: settings.sqsEndpoint,
    region: settings.region
  })
  const topicClient = createTopicClient({
    endpoint: settings.snsEndpoint,
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
      client: topicClient,
      topicArn: settings.commandsTopicArn
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
