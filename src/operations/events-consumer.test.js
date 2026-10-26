import { createHash } from 'node:crypto'

import nock from 'nock'

import { exampleEvent } from '#/common/test-helpers/gitops-messages.js'
import { createSqsClient } from '#/adapters/sqs/sqs-command-publisher.js'
import {
  createEventsConsumer,
  createMessageHandler
} from '#/operations/events-consumer.js'

// The repo's global test setup (.vite/setup-files.js) replaces global.fetch
// with vitest-fetch-mock for every file - undo that here so nock sees the
// SDK's requests.
const realFetch = globalThis.fetch
const mockedFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = realFetch
})

afterAll(() => {
  globalThis.fetch = mockedFetch
})

const ENDPOINT = 'http://sqs.test:4566'
const QUEUE_URL = `${ENDPOINT}/000000000000/gitops-events.fifo`
const SETTINGS = { handlerTimeoutMs: 5000, waitTimeSeconds: 1 }

describe('createMessageHandler', () => {
  let handler
  let logger

  beforeEach(() => {
    handler = { handle: vi.fn().mockResolvedValue(undefined) }
    logger = { warn: vi.fn() }
  })

  test('parses the JSON body and passes the event to the handler', async () => {
    const event = exampleEvent('committed')

    const message = { MessageId: 'm-1', Body: JSON.stringify(event) }

    // sqs-consumer deletes a message only when the handler returns it.
    await expect(createMessageHandler(handler, logger)(message)).resolves.toBe(
      message
    )

    expect(handler.handle).toHaveBeenCalledTimes(1)
    expect(handler.handle).toHaveBeenCalledWith(event)
  })

  test('waits for the handler before it resolves', async () => {
    let finished = false

    handler.handle.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      finished = true
    })

    await createMessageHandler(handler, logger)({ Body: '{}' })

    expect(finished).toBe(true)
  })

  test.each([
    ['text that is not JSON', 'definitely not json {'],
    ['an empty body', ''],
    ['no body at all', undefined]
  ])(
    'logs %s with the message ID only and acknowledges it without calling the handler',
    async (name, body) => {
      const dropped = { MessageId: 'm-2', Body: body }

      await expect(
        createMessageHandler(handler, logger)(dropped)
      ).resolves.toBe(dropped)

      expect(handler.handle).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        { messageId: 'm-2' },
        'A message that is not JSON was dropped'
      )
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('definitely')
    }
  )

  test('drops a message that is not JSON when there is no logger', async () => {
    const dropped = { MessageId: 'm-3', Body: 'nope' }

    await expect(createMessageHandler(handler)(dropped)).resolves.toBe(dropped)
    expect(handler.handle).not.toHaveBeenCalled()
  })

  test('lets a handler error propagate so the message is redelivered', async () => {
    const failure = new Error('database is down')

    handler.handle.mockRejectedValue(failure)

    await expect(
      createMessageHandler(handler, logger)({ MessageId: 'm-4', Body: '{}' })
    ).rejects.toBe(failure)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('createEventsConsumer', () => {
  let handler
  let logger
  let consumer
  let received
  let deleted

  function bodyOf(body) {
    return typeof body === 'string' ? JSON.parse(body) : body
  }

  function message(event, id = 'm-1') {
    const Body = JSON.stringify(event)

    return {
      MessageId: id,
      ReceiptHandle: `receipt-${id}`,
      Body,
      MD5OfBody: createHash('md5').update(Body).digest('hex')
    }
  }

  // Serves the given replies to the first receives, then empty ones, slowly
  // enough that the consumer's poll loop does not spin.
  function serveReceives(...replies) {
    const scope = nock(ENDPOINT, {
      reqheaders: { 'x-amz-target': 'AmazonSQS.ReceiveMessage' }
    })

    for (const [status, payload] of replies) {
      scope
        .post('/', (body) => {
          received.push(bodyOf(body))
          return true
        })
        .reply(status, payload)
    }

    nock(ENDPOINT, {
      reqheaders: { 'x-amz-target': 'AmazonSQS.ReceiveMessage' }
    })
      .persist()
      .post('/', (body) => {
        received.push(bodyOf(body))
        return true
      })
      .delay(50)
      .reply(200, {})
  }

  function serveDeletes() {
    nock(ENDPOINT, {
      reqheaders: { 'x-amz-target': 'AmazonSQS.DeleteMessage' }
    })
      .persist()
      .post('/', (body) => {
        deleted.push(bodyOf(body))
        return true
      })
      .reply(200, {})
  }

  function create(overrides = {}) {
    consumer = createEventsConsumer({
      queueUrl: QUEUE_URL,
      sqs: createSqsClient({ endpoint: ENDPOINT, region: 'eu-west-2' }),
      handler,
      settings: SETTINGS,
      logger,
      ...overrides
    })

    return consumer
  }

  async function until(assertion) {
    await vi.waitFor(assertion, { timeout: 4000, interval: 20 })
  }

  beforeEach(() => {
    received = []
    deleted = []
    handler = { handle: vi.fn().mockResolvedValue(undefined) }
    logger = { warn: vi.fn(), error: vi.fn() }
    serveDeletes()
  })

  afterEach(() => {
    consumer?.stop({ abort: true })
    consumer = undefined
    nock.cleanAll()
  })

  test('is not running until it is started', () => {
    expect(create().isRunning).toBe(false)
  })

  describe('when a message arrives', () => {
    const event = exampleEvent('committed')

    beforeEach(() => serveReceives([200, { Messages: [message(event)] }]))

    test('hands the parsed event to the handler and then deletes the message', async () => {
      create().start()

      await until(() => expect(deleted).toHaveLength(1))

      expect(handler.handle).toHaveBeenCalledTimes(1)
      expect(handler.handle).toHaveBeenCalledWith(event)
      expect(deleted[0]).toEqual({
        QueueUrl: QUEUE_URL,
        ReceiptHandle: 'receipt-m-1'
      })
      expect(handler.handle.mock.invocationCallOrder[0]).toBeLessThan(
        Date.now()
      )
      expect(logger.warn).not.toHaveBeenCalled()
      expect(logger.error).not.toHaveBeenCalled()
    })

    test('polls for one message at a time with the configured wait', async () => {
      create().start()

      await until(() => expect(received.length).toBeGreaterThan(0))

      expect(received[0]).toMatchObject({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60
      })
    })

    test('does not delete the message before the handler has finished', async () => {
      let release
      const gate = new Promise((resolve) => {
        release = resolve
      })

      handler.handle.mockReturnValue(gate)
      create().start()

      await until(() => expect(handler.handle).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(deleted).toEqual([])

      release()
      await until(() => expect(deleted).toHaveLength(1))
    })
  })

  describe('start and stop', () => {
    beforeEach(() => serveReceives())

    test('reflects the state of the consumer', async () => {
      const events = create()

      events.start()
      expect(events.isRunning).toBe(true)

      events.stop()
      expect(events.isRunning).toBe(false)
    })

    // A poll already in flight when a consumer is stopped and started again
    // finishes against the empty reply; waiting lets it end before the next test.
    async function settle() {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }

    test('stops polling after stop', async () => {
      const events = create()

      events.start()
      await until(() => expect(received.length).toBeGreaterThan(0))
      events.stop({ abort: true })
      await settle()

      const polls = received.length

      await settle()

      expect(received).toHaveLength(polls)
      expect(events.isRunning).toBe(false)
    })

    test('can be started again after it stopped', async () => {
      const events = create()

      events.start()
      events.stop()
      events.start()

      expect(events.isRunning).toBe(true)
      await settle()
    })

    test('ignores a second start and a second stop', async () => {
      const events = create()

      events.start()
      events.start()
      expect(events.isRunning).toBe(true)

      events.stop()
      events.stop()
      expect(events.isRunning).toBe(false)
      await settle()
    })
  })

  describe('when the message cannot be handled', () => {
    const event = exampleEvent('committed', {
      requestedBy: 'entra:00000000-0000-0000-0000-0000000000aa'
    })

    beforeEach(() => serveReceives([200, { Messages: [message(event)] }]))

    test('logs the message ID and the failure without the body, and leaves the message on the queue', async () => {
      handler.handle.mockRejectedValue(new Error('database is down'))
      create().start()

      await until(() => expect(logger.warn).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(logger.warn).toHaveBeenCalledWith(
        { messageId: 'm-1', message: 'database is down' },
        'An event could not be handled and will be redelivered'
      )
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
        event.requestedBy
      )
      expect(deleted).toEqual([])
    })

    test('logs a handler that runs out of time and leaves the message on the queue', async () => {
      handler.handle.mockReturnValue(new Promise(() => {}))
      create({ settings: { ...SETTINGS, handlerTimeoutMs: 50 } }).start()

      await until(() => expect(logger.warn).toHaveBeenCalledTimes(1))

      expect(logger.warn).toHaveBeenCalledWith(
        { messageId: 'm-1', message: expect.stringContaining('50') },
        'An event timed out and will be redelivered'
      )
      expect(deleted).toEqual([])
    })

    test('works without a logger', async () => {
      handler.handle.mockRejectedValue(new Error('database is down'))
      create({ logger: undefined }).start()

      await until(() => expect(handler.handle).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(deleted).toEqual([])
    })
  })

  describe('when a message is not JSON', () => {
    test('acknowledges it without calling the handler', async () => {
      serveReceives([
        200,
        {
          Messages: [
            {
              MessageId: 'm-9',
              ReceiptHandle: 'receipt-m-9',
              Body: 'not json',
              MD5OfBody: createHash('md5').update('not json').digest('hex')
            }
          ]
        }
      ])
      create().start()

      await until(() => expect(deleted).toHaveLength(1))

      expect(handler.handle).not.toHaveBeenCalled()
      expect(deleted[0].ReceiptHandle).toBe('receipt-m-9')
      expect(logger.warn).toHaveBeenCalledWith(
        { messageId: 'm-9' },
        'A message that is not JSON was dropped'
      )
    })
  })

  describe('when the queue fails', () => {
    test('logs the failure of the queue', async () => {
      serveReceives([
        400,
        {
          __type: 'com.amazonaws.sqs#QueueDoesNotExist',
          message: 'The specified queue does not exist.'
        }
      ])
      create().start()

      await until(() => expect(logger.error).toHaveBeenCalled())

      expect(logger.error).toHaveBeenCalledWith(
        { message: expect.stringContaining('queue does not exist') },
        'The events queue failed'
      )
      expect(handler.handle).not.toHaveBeenCalled()
    })

    test('keeps polling after a failure', async () => {
      serveReceives(
        [
          400,
          { __type: 'com.amazonaws.sqs#QueueDoesNotExist', message: 'gone' }
        ],
        [200, { Messages: [message(exampleEvent('committed'))] }]
      )
      create({ settings: { ...SETTINGS, errorPauseMs: 20 } }).start()

      await until(() => expect(handler.handle).toHaveBeenCalledTimes(1))
    })
  })
})
