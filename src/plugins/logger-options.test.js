import { Writable } from 'node:stream'

import pino from 'pino'
import { afterEach, describe, expect, test, vi } from 'vitest'

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.secret-payload.secret-signature'

function logRequestWith(redact) {
  const lines = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString())
      done()
    }
  })
  const logger = pino({ redact }, stream)

  logger.info({
    req: { headers: { authorization: `Bearer ${TOKEN}`, cookie: 'sid=1' } }
  })

  return lines.join('')
}

describe('#loggerOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('never logs the Authorization header, outside production', async () => {
    const { loggerOptions } = await import('#/plugins/logger-options.js')

    expect(logRequestWith(loggerOptions.redact)).not.toContain(TOKEN)
  })

  test('never logs the Authorization header, in production', async () => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')
    const { loggerOptions } = await import('#/plugins/logger-options.js')

    expect(loggerOptions.redact.paths).toContain('req.headers.authorization')
    expect(logRequestWith(loggerOptions.redact)).not.toContain(TOKEN)
  })
})
