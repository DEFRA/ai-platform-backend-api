import {
  createHash,
  createHmac,
  createSign,
  generateKeyPairSync
} from 'node:crypto'

import nock from 'nock'
import { ObjectId } from 'mongodb'

// Test-only: mints Entra-shaped access tokens with a throwaway RSA key and
// serves that key's JWKS through nock at the real Entra address, so the
// backend's validation runs unchanged (design E #portal).

export const ENTRA_HOST = 'https://login.microsoftonline.com'
export const TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'
export const AUDIENCE = '11111111-1111-4111-8111-111111111111'
export const FRONTEND_CLIENT_ID = '22222222-2222-4222-8222-222222222222'
export const ISSUER = `${ENTRA_HOST}/${TENANT_ID}/v2.0`
export const JWKS_PATH = `/${TENANT_ID}/discovery/v2.0/keys`
export const KID = 'test-signing-key'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048
})
const otherKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })

/**
 * The tests' signing key, and one the JWKS does not hold.
 */
export const signingKey = privateKey
export const unknownSigningKey = otherKeyPair.privateKey

/**
 * The JWKS Entra would publish: the tests' one signing key.
 * @param {{kid?: string}} [options]
 */
export function publicJwks({ kid = KID } = {}) {
  return {
    keys: [{ ...publicKey.export({ format: 'jwk' }), use: 'sig', kid }]
  }
}

/**
 * Serves the JWKS at the Entra address for the rest of the file.
 */
export function serveJwks() {
  return nock(ENTRA_HOST)
    .persist()
    .get(JWKS_PATH)
    .reply(200, () => publicJwks())
}

const base64url = (value) =>
  Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value)
  ).toString('base64url')

/**
 * Signs `claims` as an RS256 JWT with the tests' key by default.
 * @param {object} claims
 * @param {{kid?: string, alg?: string, key?: import('node:crypto').KeyObject, header?: object}} [options]
 */
export function mintToken(
  claims,
  { kid = KID, alg = 'RS256', key = privateKey, header } = {}
) {
  const head = base64url({ alg, typ: 'JWT', kid, ...header })
  const body = base64url(claims)
  const signingInput = `${head}.${body}`

  if (alg === 'none') {
    return `${signingInput}.`
  }

  if (alg === 'HS256') {
    const signature = createHmac(
      'sha256',
      publicKey.export({ type: 'spki', format: 'pem' })
    )
      .update(signingInput)
      .digest('base64url')

    return `${signingInput}.${signature}`
  }

  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(key, 'base64url')

  return `${signingInput}.${signature}`
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * The claims of a valid delegated (signed-in person) token. Override any
 * claim; `undefined` removes it.
 * @param {object} [overrides]
 */
export function delegatedClaims(overrides = {}) {
  const iat = nowSeconds()

  return withOverrides(
    {
      iss: ISSUER,
      aud: AUDIENCE,
      tid: TENANT_ID,
      ver: '2.0',
      azp: FRONTEND_CLIENT_ID,
      azpacr: '2',
      idtyp: 'user',
      scp: 'Portal.Access',
      acct: 0,
      oid: oidFor('default-person'),
      sub: 'subject',
      uti: 'uti-1',
      email: 'default.person@defra.gov.uk',
      name: 'Default Person',
      iat,
      nbf: iat,
      exp: iat + 3600
    },
    overrides
  )
}

/**
 * The claims of a valid app-only (the frontend itself) token: no `scp`, no
 * `acct`, and a service principal's `oid`.
 * @param {object} [overrides]
 */
export function appClaims(overrides = {}) {
  const iat = nowSeconds()

  return withOverrides(
    {
      iss: ISSUER,
      aud: AUDIENCE,
      tid: TENANT_ID,
      ver: '2.0',
      azp: FRONTEND_CLIENT_ID,
      azpacr: '2',
      idtyp: 'app',
      oid: '33333333-3333-4333-8333-333333333333',
      sub: '33333333-3333-4333-8333-333333333333',
      uti: 'uti-app',
      iat,
      nbf: iat,
      exp: iat + 3600
    },
    overrides
  )
}

function withOverrides(claims, overrides) {
  const merged = { ...claims, ...overrides }

  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined)
  )
}

const hashOf = (label) => createHash('sha1').update(label).digest('hex')

/**
 * A stable Entra object ID for a test person.
 * @param {string} label
 */
export function oidFor(label) {
  const hex = hashOf(label)

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * The `users` record id of a test person: the label itself, so what a test
 * names is what the records, the audit trail and the mock credential issuer's
 * forced-failure hook (a user ID starting `test-fail-`) see.
 * @param {string} label
 */
export function userIdFor(label) {
  return label
}

const pendingLabels = new Map()

/**
 * The Authorization header of a signed-in test person. The person's record
 * is created before the next `server.inject` of a server wrapped with
 * `withTestUsers`, as `PUT /v1/users/me` would have at sign-in.
 * @param {string} label
 * @param {object} [claims]
 */
export function authFor(label, { roles, ...claims } = {}) {
  pendingLabels.set(label, { roles })

  return {
    authorization: `Bearer ${mintToken(
      delegatedClaims({
        oid: oidFor(label),
        email: emailFor(label),
        name: label,
        ...claims
      })
    )}`
  }
}

/**
 * The credentials a service takes as its actor, for a signed-in person whose
 * record has this id: what a validated token yields.
 * @param {string} userId
 * @param {object} [overrides]
 */
export function actorFor(userId, overrides = {}) {
  return {
    kind: 'user',
    userId,
    oid: oidFor(userId),
    tid: TENANT_ID,
    azp: FRONTEND_CLIENT_ID,
    uti: `uti-${userId}`,
    email: emailFor(userId),
    name: userId,
    isPlatformAdmin: false,
    ...overrides
  }
}

/**
 * The Authorization header of the frontend's own app-only token.
 * @param {object} [claims]
 */
export function appAuth(claims = {}) {
  return { authorization: `Bearer ${mintToken(appClaims(claims))}` }
}

function emailFor(label) {
  return `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '.')}@defra.gov.uk`
}

const OBJECT_ID = /^[0-9a-f]{24}$/

// The record of a test person, made on first use, with the label as its id.
async function ensurePerson(db, label, roles = ['research-user']) {
  const now = new Date().toISOString()

  return db.collection('users').findOneAndUpdate(
    { _id: userIdFor(label) },
    {
      $setOnInsert: {
        oid: oidFor(label),
        tid: TENANT_ID,
        email: emailFor(label),
        displayName: label,
        roles,
        createdAt: now,
        updatedAt: now
      }
    },
    { upsert: true, returnDocument: 'after' }
  )
}

/**
 * Creates the `users` records of the people `authFor` has named.
 * @param {import('mongodb').Db} db
 */
export async function provisionUsers(db) {
  for (const [label, { roles }] of pendingLabels) {
    await ensurePerson(db, label, roles)
  }

  pendingLabels.clear()
}

/**
 * The token header for the person an `x-user-id` value names: a person who
 * signed in (the value is the record's id), else a test person of that name,
 * made on first use.
 * @param {import('mongodb').Db} db
 * @param {string} value
 */
async function headersForUser(db, value) {
  const signedIn = OBJECT_ID.test(value)
    ? await db.collection('users').findOne({ _id: new ObjectId(value) })
    : null
  const person = signedIn ?? (await ensurePerson(db, value))

  return {
    authorization: `Bearer ${mintToken(
      delegatedClaims({
        oid: person.oid,
        tid: person.tid,
        email: person.email,
        name: person.displayName
      })
    )}`
  }
}

/**
 * Makes `server.inject` carry `headers` unless a request sets its own, so a
 * file of catalogue tests need not repeat the same token on every call.
 * @param {import('@hapi/hapi').Server} server
 * @param {Record<string, string>} headers
 */
export function withDefaultHeaders(server, headers) {
  const inject = server.inject.bind(server)

  server.inject = (options) =>
    inject({ ...options, headers: { ...headers, ...options.headers } })

  return server
}

/**
 * Makes `server.inject` act for signed-in test people. A person named by
 * `authFor` has their record made before the request. Older tests name the
 * caller with an `x-user-id` header: that header is replaced by the named
 * person's token and never reaches the backend, which ignores it.
 * @param {import('@hapi/hapi').Server} server
 */
export function withTestUsers(server) {
  const inject = server.inject.bind(server)

  server.inject = async (options) => {
    await provisionUsers(server.db)

    const { 'x-user-id': userId, ...headers } = options?.headers ?? {}

    if (userId === undefined) {
      return inject(options)
    }

    return inject({
      ...options,
      headers: { ...headers, ...(await headersForUser(server.db, userId)) }
    })
  }

  return server
}

/**
 * Signs a person in as `PUT /v1/users/me` does, from claims: the call the
 * old `POST /v1/users` sign-in helpers made. Returns the response.
 * @param {import('@hapi/hapi').Server} server
 * @param {{oid: string, tid?: string, email: string, displayName: string}} person
 */
export function signInAs(server, { oid, tid = TENANT_ID, email, displayName }) {
  return server.inject({
    method: 'PUT',
    url: '/v1/users/me',
    headers: {
      authorization: `Bearer ${mintToken(
        delegatedClaims({ oid, tid, email, name: displayName })
      )}`
    }
  })
}
