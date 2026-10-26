import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'

import {
  assertPublishable,
  messageGroupId
} from '#/adapters/command-publisher.js'

const DEFAULT_REGION = 'eu-west-2'
// A local queue (Floci) accepts any credentials, so the standard ones are
// used when set and the conventional literals otherwise; against AWS the
// default provider chain applies.
const LOCAL_CREDENTIAL = 'test'

/**
 * Creates the SQS client. With an `endpoint` (a local queue) it uses static
 * local credentials; without one it relies on the default AWS provider chain.
 * @param {{endpoint?: string, region?: string}} [options]
 * @returns {SQSClient}
 */
export function createSqsClient({ endpoint, region } = {}) {
  return new SQSClient({
    region: region ?? process.env.AWS_REGION ?? DEFAULT_REGION,
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? LOCAL_CREDENTIAL,
            secretAccessKey:
              process.env.AWS_SECRET_ACCESS_KEY ?? LOCAL_CREDENTIAL
          }
        }
      : {})
  })
}

/**
 * Creates the SQS FIFO `CommandPublisher`. A command that fails the
 * `aip.gitops.command/1` schema is refused before anything is sent; an SDK
 * error is propagated as it is.
 * @param {{client: SQSClient, queueUrl: string}} options
 * @returns {import('#/adapters/command-publisher.js').CommandPublisher}
 */
export function createSqsCommandPublisher({ client, queueUrl }) {
  return {
    async publish(command) {
      assertPublishable(command)

      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(command),
          MessageGroupId: messageGroupId(command),
          MessageDeduplicationId: command.commandId
        })
      )
    }
  }
}
