const DEFAULT_REGION = 'eu-west-2'
// A local AWS emulator (Floci) accepts any credentials, so the standard ones
// are used when set and the conventional literals otherwise; against AWS the
// default provider chain applies.
const LOCAL_CREDENTIAL = 'test'

/**
 * The client options the SQS and SNS clients share. With an `endpoint` (a
 * local emulator) they use static local credentials; without one they rely on
 * the default AWS provider chain.
 * @param {{endpoint?: string, region?: string}} [options]
 * @returns {{region: string, endpoint?: string, credentials?: {accessKeyId: string, secretAccessKey: string}}}
 */
export function awsClientOptions({ endpoint, region } = {}) {
  return {
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
  }
}
