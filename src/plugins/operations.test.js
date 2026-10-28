import { operations } from '#/plugins/operations.js'
import { createServerOperations } from '#/operations/server-operations.js'

// The real runtime, spied on so a test can reach the document builder the
// plugin wires into it.
vi.mock('#/operations/server-operations.js', async (importOriginal) => {
  const actual = await importOriginal()

  return {
    ...actual,
    createServerOperations: vi.fn(actual.createServerOperations)
  }
})

describe('#operations plugin', () => {
  let server
  let transport
  let registry

  function fakeServer() {
    return {
      db: { collection: vi.fn().mockReturnValue({}) },
      locker: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      app: {},
      decorate: vi.fn(),
      events: { on: vi.fn() },
      ext: vi.fn()
    }
  }

  function handlerOf(mock, name) {
    return mock.mock.calls.find(([event]) => event === name)[1]
  }

  beforeEach(() => {
    server = fakeServer()
    transport = {
      publisher: { publish: vi.fn() },
      runReader: {},
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined)
    }
    registry = {
      key: 'sqs',
      reader: {},
      createTransport: vi.fn().mockReturnValue(transport),
      mockOutcomeOf: () => null
    }
  })

  function register(options = { registry, verifier: { verify: vi.fn() } }) {
    operations.plugin.register(server, options)
  }

  test('is registered after the database it reads', () => {
    expect(operations.plugin.name).toBe('operations')
    expect(operations.plugin.dependencies).toEqual(['mongodb'])
  })

  test('exposes the runtime as server.app.operations and the operations service to requests', () => {
    register()

    expect(server.app.operations.operations.request).toEqual(
      expect.any(Function)
    )
    expect(server.app.operations.transport).toBe(transport)
    expect(registry.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ db: server.db, logger: server.logger })
    )

    const [type, name, method, options] = server.decorate.mock.calls[0]

    expect(type).toBe('request')
    expect(name).toBe('operations')
    expect(options).toEqual({ apply: true })
    expect(method()).toBe(server.app.operations.operations)
  })

  test('starts the runtime when the server starts', () => {
    register()

    expect(transport.start).not.toHaveBeenCalled()

    handlerOf(server.events.on, 'start')()

    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(server.logger.info).toHaveBeenCalledWith('Operations started')

    return server.app.operations.stop()
  })

  test('stops the runtime before the server stops', async () => {
    register()

    await handlerOf(server.ext, 'onPreStop')()

    expect(transport.stop).toHaveBeenCalledTimes(1)
  })

  test('builds documents from the registry it is given, not the configured one', async () => {
    const teamId = '651f2c0f5c1b4a0012ab34cd'
    const getCurrentDocument = vi.fn().mockResolvedValue({
      document: {
        revision: 7,
        gateway: { limits: { requestsPerMinute: 1, tokensPerMinute: 2 } }
      }
    })

    registry.reader = { getCurrentDocument }
    server.db.collection = vi.fn().mockReturnValue({
      findOne: vi.fn().mockResolvedValue({
        slug: 'alpha',
        serviceCode: 'ABC'
      })
    })
    register()

    const { buildDocument } = createServerOperations.mock.lastCall[0]
    const built = await buildDocument({
      _id: 'operation-1',
      teamId,
      environment: 'infradev',
      items: [{ modelSlug: 'gpt-4o', change: 'remove' }],
      requestedBy: 'entra:1'
    })

    expect(getCurrentDocument).toHaveBeenCalledWith({
      path: 'environments/infradev/alpha.json'
    })
    expect(built.expectedRevision).toBe(7)
    expect(built.document.revision).toBe(8)
    expect(built.document.team).toEqual({ slug: 'alpha', serviceCode: 'ABC' })

    await server.app.operations.stop()
  })

  test('uses the configured orchestrator and verifier when none are given', async () => {
    operations.plugin.register(server)

    expect(server.app.operations.operations.reconcile).toEqual(
      expect.any(Function)
    )

    await server.app.operations.stop()
  })
})
