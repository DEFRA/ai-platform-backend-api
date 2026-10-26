import { createInMemoryCommandPublisher } from '#/adapters/in-memory-command-publisher.js'
import { describeCommandPublisherContract } from '#/adapters/command-publisher-contract.js'
import { exampleCommand } from '#/common/test-helpers/gitops-messages.js'

const FIVE_MINUTES_MS = 5 * 60 * 1000

describeCommandPublisherContract(
  'in-memory queue',
  () => createInMemoryCommandPublisher(),
  {
    failTransport(publisher) {
      publisher.setAvailable(false)
    }
  }
)

describe('#createInMemoryCommandPublisher', () => {
  test('records and delivers an accepted command', async () => {
    const queue = createInMemoryCommandPublisher()
    const command = exampleCommand()

    await queue.publish(command)

    expect(queue.published).toEqual([command])
    expect(queue.delivered).toEqual([command])
  })

  test('accepts a duplicate commandId within five minutes but delivers it once', async () => {
    let clock = 1_000_000
    const queue = createInMemoryCommandPublisher({ now: () => clock })
    const command = exampleCommand()

    await queue.publish(command)
    clock += FIVE_MINUTES_MS - 1
    await queue.publish(command)

    expect(queue.published).toHaveLength(2)
    expect(queue.delivered).toEqual([command])
  })

  test('delivers the same commandId again once five minutes have passed', async () => {
    let clock = 1_000_000
    const queue = createInMemoryCommandPublisher({ now: () => clock })
    const command = exampleCommand()

    await queue.publish(command)
    clock += FIVE_MINUTES_MS
    await queue.publish(command)

    expect(queue.delivered).toEqual([command, command])
  })

  test('keeps the order of deliveries within a group while two groups interleave', async () => {
    const order = []
    const releases = []
    const queue = createInMemoryCommandPublisher({
      onDeliver: (command) =>
        new Promise((resolve) => {
          order.push(`start ${command.operationId}`)
          releases.push(() => {
            order.push(`end ${command.operationId}`)
            resolve()
          })
        })
    })
    const first = exampleCommand({ operationId: 'alpha-001' })
    const second = exampleCommand({ operationId: 'alpha-002' })
    const other = exampleCommand({ operationId: 'beta-001', team: 'beta' })

    const publishes = [
      queue.publish(first),
      queue.publish(second),
      queue.publish(other)
    ]

    await vi.waitFor(() => expect(releases).toHaveLength(2))

    expect(order).toEqual(['start alpha-001', 'start beta-001'])

    releases[0]()
    await vi.waitFor(() => expect(releases).toHaveLength(3))
    releases[1]()
    releases[2]()
    await Promise.all(publishes)

    expect(queue.delivered.map(({ operationId }) => operationId)).toEqual([
      'alpha-001',
      'beta-001',
      'alpha-002'
    ])
    expect(order.indexOf('start alpha-002')).toBeGreaterThan(
      order.indexOf('end alpha-001')
    )
  })

  test('rejects with queue unavailable until it is made available again', async () => {
    const queue = createInMemoryCommandPublisher()
    const command = exampleCommand()

    queue.setAvailable(false)

    await expect(queue.publish(command)).rejects.toThrow('queue unavailable')
    expect(queue.published).toEqual([])
    expect(queue.delivered).toEqual([])

    queue.setAvailable(true)
    await queue.publish(command)

    expect(queue.delivered).toEqual([command])
  })

  test('passes each delivery to onDeliver and swallows its errors', async () => {
    const onDeliver = vi.fn().mockRejectedValue(new Error('consumer failed'))
    const queue = createInMemoryCommandPublisher({ onDeliver })
    const command = exampleCommand()

    await expect(queue.publish(command)).resolves.toBeUndefined()

    expect(onDeliver).toHaveBeenCalledExactlyOnceWith(command)
    expect(queue.delivered).toEqual([command])
  })

  test('refuses an invalid command without recording it', async () => {
    const queue = createInMemoryCommandPublisher()

    await expect(
      queue.publish(exampleCommand({ unexpected: true }))
    ).rejects.toMatchObject({ code: 'invalid-command' })
    expect(queue.published).toEqual([])
  })
})
