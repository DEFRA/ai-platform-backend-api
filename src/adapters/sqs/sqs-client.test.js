import nock from 'nock'
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock sees the
// SDK's requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

const { createSqsClient } = await import('#/adapters/sqs/sqs-client.js')

const ENDPOINT = 'http://sqs.test:4566'

describe('#createSqsClient', () => {
  afterEach(() => {
    nock.cleanAll()
    vi.unstubAllEnvs()
  })

  test('targets the given endpoint and region, with the standard test credentials for a local queue', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', undefined)
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined)

    const client = createSqsClient({ endpoint: ENDPOINT, region: 'eu-west-1' })

    expect(await client.config.region()).toBe('eu-west-1')
    expect((await client.config.endpoint()).hostname).toBe('sqs.test')
    expect(await client.config.credentials()).toMatchObject({
      accessKeyId: 'test',
      secretAccessKey: 'test'
    })
  })

  test('uses the AWS endpoint and the default credential provider chain when no endpoint is given', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'chain-key')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'chain-secret')
    vi.stubEnv('AWS_REGION', 'eu-west-2')

    const headers = []

    nock('https://sqs.eu-west-2.amazonaws.com')
      .post('/')
      .reply(200, function () {
        headers.push(this.req.headers)
        return {}
      })

    await createSqsClient().send(
      new ReceiveMessageCommand({
        QueueUrl: 'https://sqs.eu-west-2.amazonaws.com/000000000000/q.fifo'
      })
    )

    expect(headers[0].authorization).toContain('Credential=chain-key/')
  })
})
