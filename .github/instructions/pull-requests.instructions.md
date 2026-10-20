---
description: 'Use when preparing, opening or reviewing a pull request in this repo: what to run first, what a reviewer (human or Copilot) checks, and how to request Copilot review. Complements copilot-instructions.md, which is longer than Copilot code review reads.'
applyTo: '**'
---

# Pull requests and review

## Before opening

- Branch `<type>/<description>` from current `main`; conventional commits.
- Run `npm run format`, then `npm run format:check`, `npm run lint` and `npm test`; all pass. Never `--no-verify`.
- Behaviour change means a test change; a bug fix means a regression test that fails without the fix.
- Update `ai-platform-frontend/docs/implemented-features.md` and the plan when a plan phase lands (see `route-plans.instructions.md`).
- A new persisted field needs a dated backfill (see `schema-changes.instructions.md`).
- Build to the current design only: no legacy paths or backwards-compatible fallbacks.

## What review checks (Copilot included)

- **Routes are thin.** Joi validates, rejects unknown keys (`.unknown(false)`), then one service method is called. No business logic or direct DB access in routes.
- **Secrets.** Never log or persist a full key or token. A full credential is returned only at creation and rotation; `keyHint` everywhere else. No PII in any log line.
- **Errors** use `@hapi/boom` with a stable `code`; creating endpoints take an `Idempotency-Key`.
- **Concurrency.** Non-atomic multi-step writes hold a `mongo-locks` lock, released in `finally`. Mongo queries use the driver's query objects, never concatenated input.
- **Adapters.** Services depend on a port (`CredentialIssuer`, `CredentialVault`, `CatalogueSource`), never on a concrete adapter; a real adapter has a shared contract test with the mock.
- **API.** RESTful JSON: right method and status, `Location` on `201`, plural nouns.
- **Style.** ES modules with named exports, function declarations, JSDoc on exports, exact-pinned dependencies, no lodash, moment or mongoose.
- **Tests** colocated as `<name>.test.js`; `nock` for network; coverage does not fall.

## Requesting review

1. Open the PR (draft while checks fail) and describe what changed, why, and how it was verified; call out breaking changes.
2. **Request Copilot review**: `gh pr edit <n> --add-reviewer "@copilot"`.
3. Read every comment. Fix it, or reply with the reason it does not apply, then resolve the thread. Re-request Copilot after a substantial push.
4. Then request a human reviewer. Copilot is advisory and never replaces the required approval; the ruleset needs one approving review, resolved threads and approval of the last push.
5. Do not merge your own PR.
