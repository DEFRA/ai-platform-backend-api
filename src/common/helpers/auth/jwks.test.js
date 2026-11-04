import nock from 'nock'

import {
  SIGNING_ALGORITHMS,
  fetchSigningKeys,
  keyFor
} from '#/common/helpers/auth/jwks.js'
import { KID, publicJwks } from '#/common/test-helpers/portal-token.js'

const HOST = 'https://keys.example.test'
const PATH = '/keys'

describe('#fetchSigningKeys', () => {
  afterEach(() => {
    nock.cleanAll()
  })

  test('returns the RSA signing keys, and only those', async () => {
    const [signing] = publicJwks().keys
    nock(HOST)
      .get(PATH)
      .reply(200, {
        keys: [
          signing,
          { ...signing, kid: 'encryption', use: 'enc' },
          { ...signing, kid: 'elliptic', kty: 'EC' },
          { ...signing, kid: '' },
          { ...signing, kid: 'no-modulus', n: undefined },
          { ...signing, kid: 'no-exponent', e: undefined },
          null
        ]
      })

    const keys = await fetchSigningKeys(`${HOST}${PATH}`)

    expect(keys.map(({ kid }) => kid)).toEqual([KID])
  })

  test('reads a plain http address, the local mock issuer, directly', async () => {
    nock('http://localhost:3010').get('/jwks').reply(200, publicJwks())

    const keys = await fetchSigningKeys('http://localhost:3010/jwks')

    expect(keys).toHaveLength(1)
  })

  test.each([
    ['an error status', (scope) => scope.reply(503, 'down'), /answered 503/],
    ['a redirect', (scope) => scope.reply(302, '', { location: '/x' }), /302/],
    ['a body that is not JSON', (scope) => scope.reply(200, 'oops'), /JSON/],
    ['no keys member', (scope) => scope.reply(200, {}), /no signing key/],
    [
      'only keys it cannot use',
      (scope) =>
        scope.reply(200, { keys: [{ kty: 'EC', use: 'sig', kid: 'a' }] }),
      /no signing key/
    ],
    [
      'a body over the limit',
      (scope) => scope.reply(200, 'x'.repeat(256 * 1024 + 1)),
      /too much/
    ],
    [
      'a connection that fails',
      (scope) => scope.replyWithError('refused'),
      /refused/
    ]
  ])('rejects %s', async (_name, reply, message) => {
    reply(nock(HOST).get(PATH))

    await expect(fetchSigningKeys(`${HOST}${PATH}`)).rejects.toThrow(message)
  })

  test('rejects an endpoint that does not answer in time', async () => {
    nock(HOST).get(PATH).delay(200).reply(200, publicJwks())

    await expect(
      fetchSigningKeys(`${HOST}${PATH}`, { timeoutMs: 20 })
    ).rejects.toThrow()
  })
})

describe('#keyFor', () => {
  const keys = publicJwks().keys

  test('names RS256 as the only algorithm the key may verify', () => {
    expect(SIGNING_ALGORITHMS).toEqual(['RS256'])
    expect(keyFor(keys, KID).algorithms).toEqual(['RS256'])
  })

  test('returns the public key and its ID', () => {
    const found = keyFor(keys, KID)

    expect(found.kid).toBe(KID)
    expect(found.key.type).toBe('public')
    expect(found.key.asymmetricKeyType).toBe('rsa')
  })

  test.each([
    ['a key ID the tenant does not publish', 'unknown-key'],
    ['no key ID', undefined]
  ])('returns nothing for %s', (_name, kid) => {
    expect(keyFor(keys, kid)).toBeUndefined()
  })
})
