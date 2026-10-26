import { exampleCommand } from '#/common/test-helpers/gitops-messages.js'

/**
 * Shared `CommandPublisher` contract suite, run against every implementation
 * (SQS with a nocked endpoint, the in-memory queue) so a new transport's
 * Liskov substitution is an executable test. Every implementation resolves
 * to undefined for a valid command, rejects when its transport fails, and
 * refuses a command that fails the schema without leaking the document.
 * @param {string} name
 * @param {() => import('./command-publisher.js').CommandPublisher} createPublisher
 * @param {{arrange?: () => void, failTransport: (publisher: import('./command-publisher.js').CommandPublisher) => void}} options - `arrange` makes the transport accept sends; `failTransport` makes it fail them
 */
export function describeCommandPublisherContract(
  name,
  createPublisher,
  { arrange = () => {}, failTransport }
) {
  describe(`CommandPublisher contract: ${name}`, () => {
    test('publish resolves to undefined for a valid command', async () => {
      arrange()

      await expect(
        createPublisher().publish(exampleCommand())
      ).resolves.toBeUndefined()
    })

    test('publish rejects when the transport fails', async () => {
      arrange()

      const publisher = createPublisher()

      failTransport(publisher)

      await expect(publisher.publish(exampleCommand())).rejects.toThrow()
    })

    test('publish refuses a command with an extra field, without leaking the document', async () => {
      arrange()

      const command = exampleCommand({ unexpected: true })

      const error = await createPublisher()
        .publish(command)
        .catch((error_) => error_)

      expect(error).toBeInstanceOf(Error)
      expect(error.message).not.toContain(command.document)
    })
  })
}
