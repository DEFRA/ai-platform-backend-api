import { Writable } from 'node:stream'

import Hapi from '@hapi/hapi'
import hapiPino from 'hapi-pino'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.secret-payload.secret-signature'

// Re-importing the logger options after a module reset loads the config and
// the log formatter again, which can pass the default 5 s under a full
// coverage run.
const SLOW_IMPORT_MS = 30000

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

// The request log of a real hapi server with the real logger options, as
// the service writes it: what the log holds of a request's query string.
async function requestLogFor(url) {
  const { loggerOptions } = await import('#/plugins/logger-options.js')
  const lines = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString())
      done()
    }
  })
  const server = Hapi.server()

  server.route({ method: 'GET', path: '/v1/admin/{page}', handler: () => 'ok' })
  await server.register({
    plugin: hapiPino,
    options: { ...loggerOptions, enabled: true, stream, level: 'info' }
  })
  await server.inject({ method: 'GET', url })
  await server.stop({ timeout: 0 })

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

  describe.each([
    ['ecs', 'ecs'],
    ['pino-pretty', 'pino-pretty']
  ])('in production, logging as %s', (_name, format) => {
    beforeEach(() => {
      vi.resetModules()
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('LOG_FORMAT', format)
    })

    test(
      'logs the other parts of the query but never the person filter of the audit log',
      async () => {
        const log = await requestLogFor(
          '/v1/admin/audit?person=zzperson&action=user.signIn'
        )

        expect(log).toContain('user.signIn')
        expect(log).not.toContain('zzperson')
      },
      SLOW_IMPORT_MS
    )

    test(
      'never logs the search of the admin Teams list',
      async () => {
        const log = await requestLogFor(
          '/v1/admin/teams?search=zzsearch&status=active'
        )

        expect(log).toContain('active')
        expect(log).not.toContain('zzsearch')
      },
      SLOW_IMPORT_MS
    )
  })

  test(
    'never logs the person filter outside production either',
    async () => {
      const log = await requestLogFor(
        '/v1/admin/audit?person=zzperson&action=user.signIn'
      )

      expect(log).not.toContain('zzperson')
    },
    SLOW_IMPORT_MS
  )
})
