import { SQSClient } from '@aws-sdk/client-sqs'

import { awsClientOptions } from '#/adapters/aws-client-options.js'

/**
 * Creates the SQS client the events consumer reads with. With an `endpoint` (a
 * local emulator) it uses static local credentials; without one it relies on
 * the default AWS provider chain.
 * @param {{endpoint?: string, region?: string}} [options]
 * @returns {SQSClient}
 */
export function createSqsClient(options) {
  return new SQSClient(awsClientOptions(options))
}
