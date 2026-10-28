import { validateCommand } from '#/contracts/message-validators.js'

/**
 * Port for handing a GitOps command to the queue that the GitOps workers
 * consume. A command is an `aip.gitops.command/1` message (validated by
 * `validateCommand` in `src/contracts/message-validators.js`). `publish`
 * resolves once the queue has accepted the command, rejects when it could
 * not be sent, and refuses (rejects without sending) a command that fails
 * the schema.
 *
 * @typedef {object} CommandPublisher
 * @property {(command: object) => Promise<void>} publish
 */

/**
 * Throws, before anything is sent, when a command fails the
 * `aip.gitops.command/1` schema. The error names the failing paths only,
 * never the document, which can hold a whole team file.
 * @param {unknown} command
 */
export function assertPublishable(command) {
  const { valid, errors } = validateCommand(command)

  if (!valid) {
    const error = new Error(
      `Refusing to publish an invalid command: ${errors.join('; ')}`
    )
    error.code = 'invalid-command'
    throw error
  }
}

/**
 * The FIFO message group of a command: its environment and team, so one
 * team's commands stay in order while teams run in parallel.
 * @param {{environment: string, team: string|null}} command
 * @returns {string}
 */
export function messageGroupId({ environment, team }) {
  return team === null ? environment : `${environment}/${team}`
}
