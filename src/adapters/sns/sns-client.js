import { SNSClient } from '@aws-sdk/client-sns'

import { awsClientOptions } from '#/adapters/aws-client-options.js'

/**
 * Creates the SNS client the command publisher sends with. With an `endpoint`
 * (a local emulator) it uses static local credentials; without one it relies
 * on the default AWS provider chain.
 * @param {{endpoint?: string, region?: string}} [options]
 * @returns {SNSClient}
 */
export function createSnsClient(options) {
  return new SNSClient(awsClientOptions(options))
}
