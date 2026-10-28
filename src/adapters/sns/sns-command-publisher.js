import { PublishCommand } from '@aws-sdk/client-sns'

import {
  assertPublishable,
  messageGroupId
} from '#/adapters/command-publisher.js'

/**
 * Creates the SNS FIFO `CommandPublisher`: it publishes to the commands topic
 * the backend owns, and the worker's own queue is subscribed to that topic
 * (raw delivery, so the worker reads exactly the command). A command that
 * fails the `aip.gitops.command/1` schema is refused before anything is sent;
 * an SDK error is propagated as it is.
 * @param {{client: import('@aws-sdk/client-sns').SNSClient, topicArn: string}} options
 * @returns {import('#/adapters/command-publisher.js').CommandPublisher}
 */
export function createSnsCommandPublisher({ client, topicArn }) {
  return {
    async publish(command) {
      assertPublishable(command)

      await client.send(
        new PublishCommand({
          TopicArn: topicArn,
          Message: JSON.stringify(command),
          MessageGroupId: messageGroupId(command),
          MessageDeduplicationId: command.commandId
        })
      )
    }
  }
}
