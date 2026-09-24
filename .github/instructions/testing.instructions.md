---
description: 'Use when writing or updating Vitest test files (*.test.js) in this repo — routes, services, adapters or plugins. Covers colocation, naming, and MongoDB-backed integration test setup conventions.'
applyTo: '**/*.test.js'
---

# Testing Conventions

- Colocate test files next to the file under test (e.g. `credential-service.js` + `credential-service.test.js`).
- Use Vitest globals directly (`describe`, `test`, `expect`, `beforeAll`, `afterAll`) — no need to import them.
- Route tests are integration tests using `server.inject` against a real (in-memory) Mongo via `vitest-mongodb` — see any `src/routes/*.test.js` for the `beforeAll`/`afterAll` server setup pattern.
- The `npm test` script's env vars use Unix syntax and fail in PowerShell — on Windows run `$env:TZ='UTC'; npx vitest run --coverage` instead.
- Comparing two Mongo `_id`s returned from separate finds/inserts: use `.toString()` equality, not `toBe` (reference equality fails even when the ids are equal).
- `server.inject()`'s `result` is the raw handler return value, not re-parsed JSON — Mongo `ObjectId` fields stay real `ObjectId` instances in `result`. Always call `.toString()` on an `_id` pulled from `result` before using it in a same-test `.toBe()`/equality comparison.
- Run the full suite with `npm test`; use `npm run test:watch` while iterating.
