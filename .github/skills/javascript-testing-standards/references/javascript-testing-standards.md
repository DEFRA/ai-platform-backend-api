---
layout: default
title: JavaScript Testing Standards
---

# JavaScript Testing Standards

This page outlines the testing standards for JavaScript code within the Defra AICE team — how we write tests in the team's Node.js repos. These rules exist to produce tests that give confidence in behaviour while staying easy to read and change, not to make every test look the same.

This guide is an extension to the [AICE JavaScript Style Guide](../../javascript-style-guide/references/javascript-style-guide.md) — see [1.3 Testing](../../javascript-style-guide/references/javascript-style-guide.md#13-testing) — and is intended to be used in conjunction with it.

## Table of Contents

- [1 Test Project Rules](#1-test-project-rules)
  - [1.1 Location](#11-location)
  - [1.2 Placement](#12-placement)
    - [1.2.1 The Mechanism Rule](#121-the-mechanism-rule)
    - [1.2.2 Source Tree Mirroring](#122-source-tree-mirroring)
    - [1.2.3 A Worked Example](#123-a-worked-example)
  - [1.3 Fixtures and Helpers](#13-fixtures-and-helpers)
- [2 Testing Style Guide](#2-testing-style-guide)
  - [2.1 Naming](#21-naming)
    - [2.1.1 Describe Observable Behaviour](#211-describe-observable-behaviour)
    - [2.1.2 Don't Overpromise](#212-dont-overpromise)
  - [2.2 Structure and BDD](#22-structure-and-bdd)
    - [2.2.1 When to Nest](#221-when-to-nest)
    - [2.2.2 Nesting Depth](#222-nesting-depth)
  - [2.3 Assertions](#23-assertions)
    - [2.3.1 Assertions Must Discriminate](#231-assertions-must-discriminate)
    - [2.3.2 Testing Rejections](#232-testing-rejections)
  - [2.4 Mocking](#24-mocking)
    - [2.4.1 Network and Owned Modules](#241-network-and-owned-modules)
    - [2.4.2 Third-Party Types](#242-third-party-types)
    - [2.4.3 Restoring Mutated State](#243-restoring-mutated-state)
- [Contributions](#contributions)

## 1 Test Project Rules

### 1.1 Location

All tests live under `tests/`. Never beside the source.

Do this:
```text
tests/unit/services/orders.test.js
tests/integration/pages/orders/new/new.test.js
```

Don't do this:
```text
src/services/orders.test.js
src/services/__tests__/orders.test.js
```

### 1.2 Placement

Ask what the test **addresses**. That determines the tree, the name and whether it mirrors `src/`.

| Addresses | Lives in | Named after | Mirrors `src/` |
| --- | --- | --- | --- |
| a module — imports and calls it | `tests/unit/` | the module | exactly, 1:1 |
| an entry point — page, route, handler, plugin | `tests/integration/` | the entry point | directory-level |
| a journey — a deployed running system | `tests/e2e/` | the journey | not at all |

#### 1.2.1 The Mechanism Rule

Ask only what the test drives — never "how integrated is this?" That question has no stable answer, and inconsistent answers to it are what produce incoherent suites.

Do this:
```javascript
// tests/unit/infra/catalogue/client.test.js
// Imports the class and calls it. No server anywhere.
const client = new OrdersClient({ baseUrl })

await client.request('/orders')
```

Don't do this:
```javascript
// tests/integration/infra/catalogue/client.test.js
// Nothing is integrated here, so the folder describes nothing about the test
const client = new OrdersClient({ baseUrl })
```

A plugin test that boots a minimal server with throwaway routes is an **integration** test, because it injects — even though it will feel like a unit test. Allowing "but it only registers one plugin" reopens the degree question this rule exists to close.

Do this:
```javascript
// tests/integration/server/plugins/session-guard.test.js
const server = Hapi.server()
await server.register(sessionGuard)
server.route({ method: 'GET', path: '/protected', handler: () => 'ok' })

const { statusCode } = await server.inject({ method: 'GET', url: '/protected' })
```

#### 1.2.2 Source Tree Mirroring

The mirror is a **coincidence, not a rule**. A unit test mirrors its module 1:1 because it addresses one module. An integration test mirrors a directory, because one page test legitimately covers `routes.js`, `controller.js`, `schemas.js` and `view-models.js` together. An e2e test mirrors nothing — "sign in, add an item, check out" is not a file.

The same basename may appear in both trees. That is the structure working, not a collision to fix.

Do this:
```text
tests/unit/server/catch-all.test.js          # the handler function
tests/integration/server/catch-all.test.js   # the handler wired into the app
```

For pages specifically, the integration directory nests one level per URL segment, and the leaf file repeats the final segment's name. This replicates the route's slug layout, so a test can be found from its URL without guessing, and so a sub-route can sit alongside its parent without a name clash.

Do this:
```text
tests/integration/pages/board-requests/new/new.test.js                  # route: /board-requests/new
tests/integration/pages/board-requests/new/confirmation/confirmation.test.js   # route: /board-requests/new/confirmation
```

Don't do this:
```text
tests/integration/pages/board-requests/new.test.js
tests/integration/pages/board-requests/new-confirmation.test.js   # flattens the route, loses the mapping
```

#### 1.2.3 A Worked Example

`login` is one page — one entry point — so it gets one integration test file covering the directory. `controller.js` inside it is one module, so it gets its own unit test mirrored 1:1. `catch-all.js` is both a plain function and a route handler, so — per [1.2.2](#122-the-mirror-is-a-consequence) — the same basename correctly appears in both trees.

```text
src/
├── pages/
│   └── login/
│       ├── controller.js
│       ├── routes.js
│       └── login.njk
└── server/
    ├── catch-all.js
    └── plugins/
        └── session-cache/
            └── cache-engine.js

tests/
├── unit/
│   ├── pages/
│   │   └── login/
│   │       └── controller.test.js       # addresses controller.js alone
│   └── server/
│       ├── catch-all.test.js            # addresses the handler function
│       └── plugins/
│           └── session-cache/
│               └── cache-engine.test.js
├── integration/
│   ├── pages/
│   │   └── login/
│   │       └── login.test.js            # addresses routes + controller + view together
│   └── server/
│       └── catch-all.test.js            # addresses the handler wired into a real server
├── e2e/
│   └── sign-in.test.js                  # addresses the deployed journey — no src/ mirror
└── fixtures/
    └── catalogue-api.js                 # shared response shapes, per 1.3
```

`tests/unit/pages/login/` mirrors `src/pages/login/` file-for-file, `tests/integration/pages/login/login.test.js` covers the same directory in a single file, and `tests/e2e/` mirrors nothing at all — three outcomes from the one rule in 1.2.2.

### 1.3 Fixtures and Helpers

One module owns every response shape from each external contract, and each shape records how it was verified.

Do this:
```javascript
// tests/fixtures/catalogue-api.js

/**
 * Body of POST /orders on 201.
 * Verified against the sandbox API on 2026-01-14 — a plain resource
 * representation. Note there is no `success` field.
 */
function createdOrder (overrides = {}) {
  return { id: 'ord-1', sku: 'sku-abc', status: 'pending', ...overrides }
}
```

Don't do this:
```javascript
// Declared inline in one test file, guessed rather than verified,
// and contradicted by two other files that mock the same endpoint
const responseBody = { success: true, id: 'ord-1' }
```

Always export factories that accept overrides. Never share a mutable fixture object between tests.

## 2 Testing Style Guide

### 2.1 Naming

Test names are present-tense sentences describing observable behaviour. The test name is the failure message — write it for someone reading CI output at 3am who has never opened the file.

#### 2.1.1 Describe Observable Behaviour

Do this:
```javascript
describe('ordersController', () => {
  describe('when the API accepts the order', () => {
    test('redirects to the confirmation page', async () => {
      mockApi.submitOrder.mockResolvedValue({
        status: 'accepted',
        orderId: 'ord_123'
      })

      await submitOrder(cart)

      expect(router.push)
        .toHaveBeenCalledWith('/orders/ord_123/confirmation')
    })
  })
})
```

Don't do this:
```javascript
describe('#ordersController', () => {
  test('Should provide expected response', async () => {
```

#### 2.1.2 Don't Overpromise

Never use a name that promises more than the test asserts.

Do this:
```javascript
test('sends the caller email as the X-User-Id header', async () => {
  nock(baseUrl)
    .matchHeader('X-User-Id', 'someone@example.com')
    .get('/orders')
    .reply(200, {})

  await client.request('/orders', { userId: 'someone@example.com' })
})
```

Don't do this:
```javascript
test('sends GET request with userId header', async () => {
  nock(baseUrl).get('/orders').reply(200, {})

  const res = await client.request('/orders', { userId: 'someone@example.com' })

  expect(res.ok).toBe(true)     // asserts nothing about any header
})
```

### 2.2 Structure and BDD

BDD is a thinking tool, not a syntax. Use it where the test genuinely has a Given. The discriminator is one question: **does the setup vary between sibling tests?**

#### 2.2.1 When to Nest

If yes, nest — the `describe` establishes world state, the test name states the outcome. If no, write flat Arrange/Act/Assert.

Flat was correct in the single-test `ordersController` example from [2.1.1](#211-describe-observable-behaviour). Once a sibling needs different setup, nest:

Do this:
```javascript
describe('ordersController', () => {
  describe('when the API accepts the order', () => {
    beforeEach(() => mockApi.submitOrder.mockResolvedValue({
      status: 'accepted',
      orderId: 'ord_123'
    }))

    test('redirects to the confirmation page', async () => { /* … */ })
    test('clears the cart', async () => { /* … */ })
  })

  describe('when the API rejects the order', () => {
    beforeEach(() =>
      mockApi.submitOrder.mockRejectedValue(new Error('payment declined'))
    )

    test('shows an error message', async () => { /* … */ })
    test('keeps the cart intact', async () => { /* … */ })
  })
})
```

Don't do this:
```javascript
describe('formatOrderTotal', () => {
  describe('given a list of items', () => {       // no world state — a heading
    describe('when VAT applies', () => {          // still a heading
      test('adds VAT to the total', () => { /* … */ })
```

A pure function has no Given worth stating. Put the input inline where it stays visible:

Do this:
```javascript
describe('OrderSummaryViewModel', () => {
  test('marks the order as cancellable while it is pending', () => {
    const model = OrderSummaryViewModel.fromOrder({ status: 'pending' })

    expect(model.cancellable).toBe(true)
  })
})
```

Never build a Given/When/Then DSL — step builders, `given(...).when(...).then(...)` chains, Gherkin feature files.

#### 2.2.2 Nesting Depth

Three levels of nesting is a sensible default, not a hard ceiling — and count only the levels that establish something. A `describe` that establishes nothing is a section header; delete it and fold its label into the test names rather than spending a level on it.

The distinction matters more than the number: label levels are effortless to write and slip through review, so they fill the budget first, leaving no room for a `describe` that would genuinely hoist repeated setup.

The outer `describe` isn't automatically a label. When a file covers one unambiguous thing, restating its name adds nothing. When a file exports multiple classes, addresses more than one entry point, or the filename alone doesn't say what's under test, the outer `describe` disambiguates — that's real information, and it earns a level like any other.

Do this:
```javascript
// checkoutController has two entry points, and both nested levels
// below it establish real state — all three earn their place
describe('checkoutController', () => {
  describe('when authenticated', () => {
    let server, sessionCookie

    beforeAll(async () => {
      server = await buildServer()
      sessionCookie = await loginAsTestUser(server)
    })

    describe('when the account has no payment method', () => {
      beforeEach(() => mockCatalogue.paymentMethods.mockResolvedValue([]))

      test('GET /checkout redirects to the add-card page', async () => {
        /* … */
      })
      test('POST /checkout redirects to the add-card page', async () => {
        /* … */
      })
    })
  })
})
```

Don't do this:
```javascript
describe('checkoutController', () => {
  describe('when authenticated', () => {
    describe('POST /checkout: validation', () => {
      // heading, not a Given — nothing here differentiates these
      // tests from their siblings
      // This reads as three levels already used (controller, auth,
      // heading), so the describe that would actually hoist the
      // no-payment-method setup repeated below never gets added.
      test('shows an error when the card number is missing', async () => {
        /* … */
      })
```

This rule moves files in both directions: deleting label levels frees room for a Given that collapses repeated setup, while a file whose setup genuinely varies per test comes out flatter, not deeper. Two files under the same rule can correctly end up with opposite shapes.

Even a genuine fourth real level can earn its place — but flatten a compound precondition into one describe sentence first, or reach for `test.each` if it's a real matrix, rather than forcing a load-bearing level out just to stay under the number.

### 2.3 Assertions

#### 2.3.1 Assertions Must Discriminate

**Every test must be able to fail.** A regex over rendered HTML must not match the copy of the branch that should not have run.

Do this:
```javascript
expect(payload).toContain('Your order is confirmed')
expect(payload).not.toContain('Order not placed')
```

Don't do this:
```javascript
// "Order not placed" also matches /order/i — this passes in both branches
expect(payload).toMatch(/order|someone@example\.com/i)
```

Prefer an assertion that discriminates over one that merely fires.

Do this:
```javascript
expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('production'))
```

Don't do this:
```javascript
// passes if the message becomes anything at all
expect(logger.error).toHaveBeenCalled()
```

Never assert against a value you configured on a mock in the same test — that asserts your setup, not the code. There is no "do this instead": the test should not exist.

Don't do this:
```javascript
createServerSpy.mockRejectedValue(new Error('Server failed to start'))

await expect(createServer()).rejects.toThrow('Server failed to start')
```

Banned as a test's only assertion: `toBeDefined()`, `expect(res.ok).toBe(true)`, `expect(nock.isDone()).toBe(true)`. Exception: asserting `isDone()` is **false** against a would-have-matched interceptor proves a call did not happen, and that does discriminate.

Do this:
```javascript
const refresh = nock(authUrl).post('/token').reply(200, { access_token: 'new' })

await server.inject({
  method: 'GET',
  url: '/orders',
  headers: { Cookie: liveSession }
})

// a live session must not trigger a refresh
expect(refresh.isDone()).toBe(false)
```

Assert a relationship where one exists, not merely a presence.

Do this:
```javascript
const rendered = payload.match(/<script[^>]*nonce="([^"]*)"/)[1]
const header = res.headers['content-security-policy']
  .match(/'nonce-([^']+)'/)[1]

expect(rendered).toBe(header)
```

Don't do this:
```javascript
// This form passed for months against a page rendering nonce="[object Object]"
expect(payload).toMatch(/nonce="[^"]+"/)
```

#### 2.3.2 Testing Rejections

**A bare `RegExp` inside `toMatchObject` or `toEqual` never matches — it passes silently.** Verified on vitest 4.1.9.

Do this:
```javascript
await expect(client.request('/orders')).rejects.toMatchObject({
  message: expect.stringMatching(/GET \/orders failed/)
})
```

Don't do this:
```javascript
await expect(client.request('/orders')).rejects.toMatchObject({
  // always passes, whatever the message is
  message: /GET \/orders failed/
})
```

Use one idiom for rejections. Never `try/catch` plus `expect.fail`.

Don't do this:
```javascript
try {
  await client.request('/orders')
  expect.fail('should have thrown')
} catch (err) {
  expect(err.name).toBe('ApiError')
}
```

### 2.4 Mocking

Only mock types this repo owns.

#### 2.4.1 Network and Owned Modules

For code that calls out over HTTP, that means intercepting at the network layer with `nock` rather than stubbing `fetch` or the module that wraps it. For a module this repo owns, `vi.mock()` is the right tool.

Do this:
```javascript
nock(catalogueUrl).post('/orders').reply(201, createdOrder())

// createLogger is ours — mocking it is a decision about our own boundary
vi.mock('../../src/common/logger.js', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn() }))
}))
```

Don't do this:
```javascript
vi.mock('node:fs')
vi.mock('nunjucks')
vi.mock('../../src/config/config.js')
```

If a test must mock `node:fs`, the production code usually does I/O at import time. Extract the I/O behind a function that takes its inputs as arguments, and test it against a real fixture file instead of mocking.

Do this:
```javascript
// src/server/plugins/asset-path.js — the path is an argument, so a test
// can point it at a real fixture and nothing needs mocking
function createAssetResolver ({ manifestPath }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  return (asset) => manifest[asset]?.file ?? asset
}
```

When extracting, keep the failure timing. A module that fails at boot on bad config must still fail at boot — deferring the read to first use means the health check passes while every request fails.

#### 2.4.2 Third-Party Types

The same ownership rule applies past the network layer, to any third-party type. A hand-rolled stand-in for one asserts your *belief* about someone else's contract, and nothing validates that belief — the test keeps passing against a shape the library stopped producing two majors ago. It's fixture drift applied to objects instead of HTTP bodies, and there's no wire format to catch it.

Do this:
```javascript
// The real framework toolkit, the real response lifecycle
const { statusCode, payload } = await server.inject({
  method: 'GET',
  url: '/no-such-page'
})

expect(statusCode).toBe(404)
expect(payload).toContain('Page not found')
```

Don't do this:
```javascript
// A hand-rolled stand-in for the framework's response toolkit. If the
// framework changes that contract, this test keeps passing against a
// shape that no longer exists.
const h = { view: vi.fn().mockReturnThis(), code: vi.fn().mockReturnThis() }

await catchAll(request, h)
```

The same applies to any dependency's types — an SDK client, a Redis connection, a logger from a library, a framework `request` object. Prefer driving the real type, with the network intercepted underneath it.

Mocking a type **you** own is different in kind: you control its shape, and it changes in the same commit as the tests that depend on it. That is a seam, not a guess.

Do this:
```javascript
// OrdersClient is ours, so faking it is a decision about our own boundary.
// seam: keeps the page test off the network — one line saying why, per above
vi.mock('../../src/infra/catalogue/client.js')
```

A minimal fake of a third-party type is tolerable for a handler genuinely worth a unit test, under three conditions: keep it to the surface actually used, build it in a factory rather than at module scope, and drive the same code path through the real type in an integration test. That pairing is why the same basename legitimately appears in both trees ([1.2](#12-placement)).

Do this:
```javascript
function toolkit () {
  return { view: vi.fn().mockReturnThis(), code: vi.fn().mockReturnThis() }
}

test('passes a non-error response straight through', () => {
  const h = toolkit()
  // … and tests/integration/server/catch-all.test.js drives the real toolkit
})
```

Don't do this:
```javascript
// Shared across every test in the file, so results depend on execution order
const mockToolkit = {
  view: mockView.mockReturnThis(),
  code: mockCode.mockReturnThis()
}
```

#### 2.4.3 Restoring Mutated State

Always restore a global you mutate.

Do this:
```javascript
const originalIsProduction = config.get('isProduction')

afterEach(() => config.set('isProduction', originalIsProduction))
```

For environment variables specifically, prefer `vi.stubEnv()` over mocking the config module or mutating `process.env` directly — one `vi.unstubAllEnvs()` restores everything a test stubbed, so there's nothing to track by hand.

Do this:
```javascript
afterEach(() => vi.unstubAllEnvs())

test('enables express checkout when the feature flag is set', () => {
  vi.stubEnv('FEATURE_EXPRESS_CHECKOUT', 'true')
  // …
})
```

Don't do this:
```javascript
const original = process.env.FEATURE_EXPRESS_CHECKOUT
process.env.FEATURE_EXPRESS_CHECKOUT = 'true'
// …
process.env.FEATURE_EXPRESS_CHECKOUT = original   // easy to forget
```

## Contributions

If you would like to contribute to these testing standards, please open a pull request on the [Defra AICE Team GitHub](https://github.com/DEFRA/aice-team) repository.

For anything that is not covered by these testing standards, we recommend following the [AICE JavaScript Style Guide](../../javascript-style-guide/references/javascript-style-guide.md) and staying consistent with the existing test suite. If alignment across AICE is required, please raise an issue in [Defra AICE Team GitHub](https://github.com/DEFRA/aice-team/issues).
