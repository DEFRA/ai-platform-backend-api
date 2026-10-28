import nock from 'nock'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock sees the
// SDK's requests.
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

const { createSnsClient } = await import('#/adapters/sns/sns-client.js')
const { createSnsCommandPublisher } =
  await import('#/adapters/sns/sns-command-publisher.js')
const { describeCommandPublisherContract } =
  await import('#/adapters/command-publisher-contract.js')
const { exampleCommand } =
  await import('#/common/test-helpers/gitops-messages.js')

const ENDPOINT = 'http://sns.test:4566'
const TOPIC_ARN = 'arn:aws:sns:eu-west-2:000000000000:commands.fifo'

function createPublisher() {
  return createSnsCommandPublisher({
    client: createSnsClient({ endpoint: ENDPOINT, region: 'eu-west-2' }),
    topicArn: TOPIC_ARN
  })
}

// SNS speaks the AWS query protocol: a form-encoded body, an XML reply.
function paramsOf(body) {
  return Object.fromEntries(new URLSearchParams(body))
}

function accepted() {
  return `<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">
  <PublishResult><MessageId>message-1</MessageId><SequenceNumber>1</SequenceNumber></PublishResult>
  <ResponseMetadata><RequestId>request-1</RequestId></ResponseMetadata>
</PublishResponse>`
}

function replyAccepted(captured) {
  return nock(ENDPOINT)
    .post('/', (body) => {
      captured?.push(paramsOf(body))
      return true
    })
    .reply(200, accepted)
}

function replyFailed() {
  return nock(ENDPOINT)
    .post('/')
    .reply(
      404,
      `<ErrorResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">
  <Error><Type>Sender</Type><Code>NotFound</Code><Message>Topic does not exist</Message></Error>
  <RequestId>request-1</RequestId>
</ErrorResponse>`
    )
}

afterEach(() => {
  nock.cleanAll()
})

describeCommandPublisherContract('sns (nocked endpoint)', createPublisher, {
  arrange() {
    nock(ENDPOINT).persist().post('/').reply(200, accepted)
  },
  failTransport() {
    nock.cleanAll()
    replyFailed()
  }
})

describe('#createSnsCommandPublisher', () => {
  test('publishes the command to the topic with its group and deduplication ids', async () => {
    const captured = []
    const command = exampleCommand()

    replyAccepted(captured)

    await createPublisher().publish(command)

    expect(captured).toEqual([
      {
        Action: 'Publish',
        Version: '2010-03-31',
        TopicArn: TOPIC_ARN,
        Message: JSON.stringify(command),
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

  test('propagates the SDK error when SNS rejects the message', async () => {
    replyFailed()

    await expect(createPublisher().publish(exampleCommand())).rejects.toThrow(
      'Topic does not exist'
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

describe('#createSnsClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('targets the given endpoint and region, with the standard test credentials for a local topic', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', undefined)
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined)

    const client = createSnsClient({ endpoint: ENDPOINT, region: 'eu-west-1' })

    expect(await client.config.region()).toBe('eu-west-1')
    expect((await client.config.endpoint()).hostname).toBe('sns.test')
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

    nock('https://sns.eu-west-2.amazonaws.com')
      .post('/')
      .reply(200, function () {
        headers.push(this.req.headers)
        return accepted()
      })

    await createSnsCommandPublisher({
      client: createSnsClient(),
      topicArn: TOPIC_ARN
    }).publish(exampleCommand())

    expect(headers[0].authorization).toContain('Credential=chain-key/')
  })
})
