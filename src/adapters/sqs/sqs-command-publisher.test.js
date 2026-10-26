import { createHash } from 'node:crypto'

import nock from 'nock'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock sees the
// SDK's requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

const { createSqsClient, createSqsCommandPublisher } =
  await import('#/adapters/sqs/sqs-command-publisher.js')
const { describeCommandPublisherContract } =
  await import('#/adapters/command-publisher-contract.js')
const { exampleCommand } =
  await import('#/common/test-helpers/gitops-messages.js')

const ENDPOINT = 'http://sqs.test:4566'
const QUEUE_PATH = '/000000000000/gitops-commands.fifo'
const QUEUE_URL = `${ENDPOINT}${QUEUE_PATH}`

function createPublisher() {
  return createSqsCommandPublisher({
    client: createSqsClient({ endpoint: ENDPOINT, region: 'eu-west-2' }),
    queueUrl: QUEUE_URL
  })
}

// nock hands a body over parsed or raw depending on its content type.
function bodyOf(body) {
  return typeof body === 'string' ? JSON.parse(body) : body
}

// Replies as SQS does, with the MD5 of the body it was sent.
function accepted(uri, body) {
  const { MessageBody } = bodyOf(body)

  return {
    MessageId: 'message-1',
    MD5OfMessageBody: createHash('md5').update(MessageBody).digest('hex')
  }
}

function replyAccepted(captured) {
  return nock(ENDPOINT)
    .post('/', (body) => {
      captured?.push(bodyOf(body))
      return true
    })
    .reply(200, accepted)
}

function replyFailed() {
  return nock(ENDPOINT).post('/').reply(400, {
    __type: 'com.amazonaws.sqs#QueueDoesNotExist',
    message: 'The specified queue does not exist.'
  })
}

afterEach(() => {
  nock.cleanAll()
})

describeCommandPublisherContract('sqs (nocked endpoint)', createPublisher, {
  arrange() {
    nock(ENDPOINT).persist().post('/').reply(200, accepted)
  },
  failTransport() {
    nock.cleanAll()
    replyFailed()
  }
})

describe('#createSqsCommandPublisher', () => {
  test('sends the command as an SQS FIFO message with its group and deduplication ids', async () => {
    const captured = []
    const headers = []
    const command = exampleCommand()

    nock(ENDPOINT)
      .post('/', (body) => {
        captured.push(bodyOf(body))
        return true
      })
      .reply(200, function (uri, body) {
        headers.push(this.req.headers)
        return accepted(uri, body)
      })

    await createPublisher().publish(command)

    expect(headers[0]['x-amz-target']).toBe('AmazonSQS.SendMessage')
    expect(captured).toEqual([
      {
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(command),
        MessageGroupId: 'infradev/alpha',
        MessageDeduplicationId: command.commandId
      }
    ])
  })

  test('uses the environment alone as the group of a command with no team', async () => {
    const captured = []
    const apply = exampleCommand({
      type: 'apply',
      operationId: null,
      team: null,
      path: null
    })

    for (const field of ['action', 'document', 'expectedRevision']) {
      delete apply[field]
    }

    replyAccepted(captured)

    await createPublisher().publish(apply)

    expect(captured[0].MessageGroupId).toBe('infradev')
  })

  test('propagates the SDK error when SQS rejects the message', async () => {
    replyFailed()

    await expect(createPublisher().publish(exampleCommand())).rejects.toThrow(
      'The specified queue does not exist.'
    )
  })

  test('sends nothing and does not name the document when the command is invalid', async () => {
    const scope = replyAccepted()
    const command = exampleCommand({ unexpected: true })

    const error = await createPublisher()
      .publish(command)
      .catch((caught) => caught)

    expect(error.code).toBe('invalid-command')
    expect(error.message).toContain('must NOT have additional properties')
    expect(error.message).not.toContain(command.document)
    expect(scope.isDone()).toBe(false)
  })
})

describe('#createSqsClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('targets the given endpoint and region, with the standard test credentials for a local queue', async () => {
    const client = createSqsClient({ endpoint: ENDPOINT, region: 'eu-west-1' })

    expect(await client.config.region()).toBe('eu-west-1')
    expect((await client.config.endpoint()).hostname).toBe('sqs.test')
    expect(await client.config.credentials()).toMatchObject({
      accessKeyId: 'test',
      secretAccessKey: 'test'
    })
  })

  test('reads local credentials from the standard environment when set', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'local-key')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local-secret')

    const client = createSqsClient({ endpoint: ENDPOINT })

    expect(await client.config.credentials()).toMatchObject({
      accessKeyId: 'local-key',
      secretAccessKey: 'local-secret'
    })
  })

  test('defaults the region from AWS_REGION, then to eu-west-2', async () => {
    vi.stubEnv('AWS_REGION', 'eu-west-1')

    expect(await createSqsClient({ endpoint: ENDPOINT }).config.region()).toBe(
      'eu-west-1'
    )

    vi.stubEnv('AWS_REGION', '')
    delete process.env.AWS_REGION

    expect(await createSqsClient({ endpoint: ENDPOINT }).config.region()).toBe(
      'eu-west-2'
    )
  })

  test('uses the AWS endpoint and the default credential provider chain when no endpoint is given', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'chain-key')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'chain-secret')
    vi.stubEnv('AWS_REGION', 'eu-west-2')

    const headers = []

    nock('https://sqs.eu-west-2.amazonaws.com')
      .post('/')
      .reply(200, function (uri, body) {
        headers.push(this.req.headers)
        return accepted(uri, body)
      })

    await createSqsCommandPublisher({
      client: createSqsClient(),
      queueUrl: `https://sqs.eu-west-2.amazonaws.com${QUEUE_PATH}`
    }).publish(exampleCommand())

    expect(headers[0].authorization).toContain('Credential=chain-key/')
  })
})
