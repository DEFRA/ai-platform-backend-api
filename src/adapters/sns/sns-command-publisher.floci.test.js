import {
  CreateTopicCommand,
  PublishCommand,
  SubscribeCommand
} from '@aws-sdk/client-sns'
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand
} from '@aws-sdk/client-sqs'
import { randomUUID } from 'node:crypto'

import { createSnsClient } from '#/adapters/sns/sns-client.js'
import { createSnsCommandPublisher } from '#/adapters/sns/sns-command-publisher.js'
import { createSqsClient } from '#/adapters/sqs/sqs-client.js'
import {
  exampleCommand,
  exampleEvent
} from '#/common/test-helpers/gitops-messages.js'

// Proves what the unit tests cannot: a command the backend publishes to its
// own FIFO topic reaches the queue subscribed to it as the same JSON, with no
// SNS envelope (CDP delivers raw), a repeat command ID collapses, and an event
// published to a topic reaches a queue the backend's SQS client reads. It
// needs Floci, so it runs only when FLOCI_ENDPOINT is set (README, "Docker
// Compose").
const endpoint = process.env.FLOCI_ENDPOINT

describe.skipIf(!endpoint)(
  'command publisher on Floci (SNS FIFO to SQS)',
  () => {
    const sns = createSnsClient({ endpoint })
    const sqs = createSqsClient({ endpoint })

    async function subscribedQueue(label) {
      const name = `aip-test-${label}-${randomUUID().slice(0, 8)}.fifo`
      const { TopicArn } = await sns.send(
        new CreateTopicCommand({
          Name: name,
          Attributes: { FifoTopic: 'true', ContentBasedDeduplication: 'false' }
        })
      )
      const { QueueUrl } = await sqs.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' }
        })
      )
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: ['QueueArn']
        })
      )

      await sns.send(
        new SubscribeCommand({
          TopicArn,
          Protocol: 'sqs',
          Endpoint: Attributes.QueueArn,
          Attributes: { RawMessageDelivery: 'true' }
        })
      )

      return { topicArn: TopicArn, queueUrl: QueueUrl }
    }

    async function receiveAll(queueUrl) {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 2
        })
      )

      return Messages.map((message) => message.Body)
    }

    test('delivers the command to the subscribed queue as the same JSON', async () => {
      const { topicArn, queueUrl } = await subscribedQueue('commands')
      const command = exampleCommand()

      await createSnsCommandPublisher({ client: sns, topicArn }).publish(
        command
      )

      expect(await receiveAll(queueUrl)).toEqual([JSON.stringify(command)])
    })

    test('collapses a command published twice with one command ID', async () => {
      const { topicArn, queueUrl } = await subscribedQueue('commands')
      const command = exampleCommand()
      const publisher = createSnsCommandPublisher({ client: sns, topicArn })

      await publisher.publish(command)
      await publisher.publish(command)

      expect(await receiveAll(queueUrl)).toEqual([JSON.stringify(command)])
    })

    test('reads, with the backend SQS client, an event published to the topic subscribed to its queue', async () => {
      const { topicArn, queueUrl } = await subscribedQueue('events')
      const event = exampleEvent('committed', { source: 'reconciler' })

      await sns.send(
        new PublishCommand({
          TopicArn: topicArn,
          Message: JSON.stringify(event),
          MessageGroupId: event.operationId,
          MessageDeduplicationId: event.eventId
        })
      )

      expect(await receiveAll(queueUrl)).toEqual([JSON.stringify(event)])
    })
  }
)
