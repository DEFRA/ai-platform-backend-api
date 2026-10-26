import { config } from '#/config.js'
import { createSqsTransport } from '#/adapters/sqs/sqs-transport.js'

const SETTINGS = {
  commandsQueueUrl: 'http://sqs.test:4566/000000000000/commands.fifo',
  eventsQueueUrl: 'http://sqs.test:4566/000000000000/events.fifo',
  endpoint: 'http://sqs.test:4566',
  region: 'eu-west-2',
  handlerTimeoutMs: 30000,
  waitTimeSeconds: 20
}

describe('sqs-transport', () => {
  let parts
  let handle
  let logger

  function create(overrides = {}) {
    return createSqsTransport({ handle, logger }, { ...parts, ...overrides })
  }

  beforeEach(() => {
    handle = vi.fn()
    logger = { warn: vi.fn() }
    parts = {
      settings: SETTINGS,
      createClient: vi.fn().mockReturnValue({ client: true }),
      createPublisher: vi.fn().mockReturnValue({ publish: vi.fn() }),
      createConsumer: vi
        .fn()
        .mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      createRunReader: vi.fn().mockReturnValue({ getRun: vi.fn() })
    }
  })

  test('publishes to the commands queue with one client', () => {
    const transport = create()

    expect(parts.createClient).toHaveBeenCalledTimes(1)
    expect(parts.createClient).toHaveBeenCalledWith({
      endpoint: SETTINGS.endpoint,
      region: SETTINGS.region
    })
    expect(parts.createPublisher).toHaveBeenCalledWith({
      client: { client: true },
      queueUrl: SETTINGS.commandsQueueUrl
    })
    expect(transport.publisher).toBe(
      parts.createPublisher.mock.results[0].value
    )
  })

  test('reads the events queue into the handler, within the handler timeout', () => {
    create()

    expect(parts.createConsumer).toHaveBeenCalledWith({
      queueUrl: SETTINGS.eventsQueueUrl,
      sqs: { client: true },
      handler: { handle },
      settings: { handlerTimeoutMs: 30000, waitTimeSeconds: 20 },
      logger
    })
  })

  test('corroborates with the GitHub run reader', () => {
    const transport = create()

    expect(transport.runReader).toBe(
      parts.createRunReader.mock.results[0].value
    )
  })

  test('starts and stops the consumer, aborting the request in flight', async () => {
    const transport = create()
    const created = parts.createConsumer.mock.results[0].value

    transport.start()

    expect(created.start).toHaveBeenCalledTimes(1)

    await transport.stop()

    expect(created.stop).toHaveBeenCalledWith({ abort: true })
  })

  test('builds a real client, publisher and consumer from the configuration by default', () => {
    const before = [
      config.get('gitops.commandsQueueUrl'),
      config.get('gitops.eventsQueueUrl')
    ]

    config.set('gitops.commandsQueueUrl', SETTINGS.commandsQueueUrl)
    config.set('gitops.eventsQueueUrl', SETTINGS.eventsQueueUrl)

    try {
      const transport = createSqsTransport({ handle, logger })

      expect(transport.publisher.publish).toEqual(expect.any(Function))
      expect(transport.runReader.getRun).toEqual(expect.any(Function))
      expect(transport.start).toEqual(expect.any(Function))
    } finally {
      config.set('gitops.commandsQueueUrl', before[0])
      config.set('gitops.eventsQueueUrl', before[1])
    }
  })
})
