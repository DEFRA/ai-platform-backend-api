# Project Guidelines

**ai-platform-backend-api** — Core Delivery Platform (CDP) Node.js backend. Hapi JSON API with MongoDB persistence, AWS/Azure integration, and enterprise-grade observability.

## Architecture

- **Layered structure**:
  - `src/routes/` — HTTP route definitions and thin request/response handling (validation via Joi, then delegate to services)
  - `src/services/` — Business logic, transactions, orchestration (no direct DB access)
  - `src/plugins/` — Hapi plugin initialization (logger, MongoDB connection, pulse/health, request tracing, routing)
  - `src/common/` — Shared utilities (logging helpers, MongoDB locks, validation, startup helpers)
- **Plugin-based initialization**: Database, logging, metrics, and middleware are registered as Hapi plugins at startup via `src/plugins/`.
- **Dependency injection**: Services and handlers access injected dependencies through `server.app` container for easier testing and decoupling.
- **No business logic in routes**: Route handlers validate input (Joi, reject unknown keys), call one service, and map the result.

## Build and Test

- **Install**: `npm install` (Node.js ≥24 required)
- **Dev server**: `npm run dev` (watches for changes, runs on port defined in config)
  - Debug mode: `npm run dev:debug` (Node inspector on `0.0.0.0:9229`)
- **Tests**: `npm test` (Vitest with coverage reporting; see `vitest.config.js`)
  - Watch mode: `npm test:watch`
  - Coverage thresholds are enforced in CI
- **Linting**:
  - ESLint (neostandard config): `npm run lint` (--fix available via `npm run lint:fix`)
  - Prettier formatting: `npm run format` (with format:check for CI)
  - Pre-commit hook: `npm run git:pre-commit-hook` runs security audit, format check, lint, and tests
- **Production**: `npm start` (NODE_ENV=production, loads `.env` if available)
- **Security**: `npm run security-audit` — blocks on critical-level vulnerabilities

## Conventions

- **JSDoc**: Every exported function has JSDoc comments.
- **Routes are thin**: Validate input with Joi (reject unknown keys with `.unknown(false)`), then call exactly one service method, then map and return the result.
- **Services own business logic**: Services orchestrate data access, validation, and external integrations. They do not perform HTTP request/response handling.
- **Dependency injection via server.app**: Services access MongoDB, config, and other dependencies through the injected `server.app` container, not via direct imports or global state.
- **Azure/APIM integration** (if applicable): Calls to Azure APIM go through dedicated adapter functions (e.g. `adapters/azure/apim-management-client.js`) behind a port interface (e.g. `CredentialIssuer` with `issue()`, `renew()`, `revoke()`, `suspend()`). Services never call Azure directly.
- **Sensitive data handling**:
  - Never log, persist, or return the full subscription key or tokens — only display a `keyHint` (last 4 characters).
  - Use `Idempotency-Key` headers on endpoints that create resources to prevent duplicates on retries.
- **Error handling**: Use `@hapi/boom` with stable `code` fields so the frontend can map errors to user-facing messages.
- **Authentication**: Routes that require authentication validate `x-user-id` via a `requireUser` pre-handler. Maintenance routes validate `x-maintenance-token`.
- **Network isolation**: The backend has no public ingress — it is only reachable inside the CDP network.
- **MongoDB write locks**: Guard non-atomic multi-step writes with `server.locker`/`request.locker` (`mongo-locks`, see README's [MongoDB Locks](../README.md#mongodb-locks) section): acquire via `const lock = await server.locker.lock('unique-resource-name')`, bail out if `!lock`, and always release in a `finally` (or use `await using lock = ...` for automatic release — note test coverage reports don't like that syntax). Keep the locked section small and atomic.

## Engineering standards (AICE)

The Defra AICE team's Copilot CLI plugin `aice-javascript@defra-aice` (from the [DEFRA/aice-team](https://github.com/DEFRA/aice-team) marketplace) is installed and its skills are committed at project level under `.github/skills/` — `javascript-style-guide`, `javascript-testing-standards` and `javascript-review-standards` (no `javascript-design-language`; this is a JSON API with no UI). These are live, invokable skills — consult `.github/skills/<name>/SKILL.md` directly rather than re-deriving their rules from memory. This codebase must follow them, in addition to this repo's own conventions above. Key points: ES modules with named exports only (no default exports); function declarations over arrow functions except for callbacks; classes only when state/dependencies genuinely need encapsulating, otherwise factory or standalone functions; exact-pinned dependency versions (no `^`/`~`); `vi.mock()` only for modules this repo owns, `nock` for network calls, never a hand-rolled stand-in for a third-party type. Where this repo's existing convention differs from the AICE guide (for example JSDoc style, already aligned above), the more specific rule in this file wins; otherwise follow AICE.

**Keeping AICE skills current**: the copies under `.github/skills/` are a point-in-time snapshot, not a live link — `DEFRA/aice-team` updates do not propagate automatically. To refresh: `copilot plugin update aice-javascript@defra-aice`, then re-copy the changed skill folder(s) from `~/.copilot/installed-plugins/defra-aice/aice-javascript/skills/` over `.github/skills/` in this repo, and open a PR. Do this periodically (e.g. quarterly) or when AICE announces a style guide change.

## Code Quality and Design Principles

- Apply SOLID principles pragmatically to JS modules (not just classes):
  - **Single responsibility**: routes validate and delegate; services own one area of business logic; adapters own one external integration. Don't let a service reach into another service's collection or an adapter leak business rules.
  - **Open/closed**: extend behaviour by adding new services/adapters/routes rather than editing a shared helper to special-case a new feature.
  - **Liskov substitution**: any adapter implementing a port (e.g. `CredentialIssuer`) must be a drop-in replacement for another implementation of that port — same inputs/outputs, no extra required side effects.
  - **Interface segregation**: ports expose only the methods callers need (e.g. `CredentialIssuer.issue()`), not a large multi-purpose interface.
  - **Dependency inversion**: services depend on port interfaces (`CredentialIssuer`) injected as parameters/defaults, never on a concrete adapter (e.g. the real Azure client) directly, so a mock or alternate implementation can be substituted without changing the service.
- **API layer is a RESTful JSON API**: model routes around resources and plural nouns (`/v1/models`, `/v1/credentials`), use the correct HTTP method per operation (`GET` read, `POST` create, `PATCH`/`POST .../renew` for partial updates or actions, `DELETE` remove), return the correct status code (`200`/`201`/`204`/`4xx`/`5xx`), set a `Location` header on `201 Created` responses, and always request/respond with JSON (`application/json`) — never HTML or plain text.

## Naming conventions

- **Directories and JS files**: `kebab-case` (e.g. `src/adapters/azure/apim-management-client.js`).
- **Routes (URL paths)**: lowercase, plural resource nouns with hyphens (e.g. `/v1/models`, `/v1/credentials`).
- **Environment variables**: `UPPER_SNAKE_CASE`.
- **Config keys**: `lowerCamelCase`, accessed via the `convict`-based config module — never `process.env` directly outside it.
- **Test files**: `<name>.test.js` colocated next to the file under test.

## Branching and version control

- `main` is always shippable — it must build, pass all tests, and be deployable at any time.
- All work happens on branches, never directly on `main`. Follow trunk-based development with short-lived feature branches and pull requests.
- Branch naming: `<type>/<brief-description>` (`feature/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`).
- Commit messages use conventional format: `type: short description` (`feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`).
- Open a pull request and get it reviewed before merging to `main`.

## Quality gates

CI (`.github/workflows/check-pull-request.yml`) currently runs on every PR: `npm run security-audit`, `npm ci`, `npm run format:check`, `npm run lint`, `npm test` (coverage), and a Docker image build test. All of these must pass before merging.

- SonarCloud is configured (`sonar-project.properties`) but the scan step is **currently commented out** in `check-pull-request.yml` and `publish.yml` — it is not yet an active CI gate. Don't assume a Sonar quality gate is blocking merges until that step is uncommented.
- Follow the Defra tiered coverage targets as the aspiration for any code you touch: ≥90% global, ≥95% for core business logic, 100% for error handling and security-critical paths — and never let coverage decrease from the current baseline.
- At least one approving code review from another developer before merging.

## Allowed / discouraged dependencies

This repo already complies with Defra's dependency guidance — keep it that way when adding new packages:

- Hapi, not Express/Fastify/Koa.
- Standalone `joi`, not the deprecated `@hapi/joi`.
- Native `mongodb` driver, not `mongoose`.
- Native `fetch`/`undici`, not `request` or `axios`.
- `neostandard`, not bare `eslint`/`prettier`/`standard` configs.
- No TypeScript without an approved exception — vanilla JS with JSDoc.
- No `lodash` or `moment` — use native JS methods instead.
- New dependencies must be widely used, actively maintained, and compatible with the current Node.js LTS.

## Security

- Follow OWASP Secure Coding Practices.
- Never log, persist, or expose PII (names, addresses, emails, phone numbers, NI numbers, bank details) or secrets.
- Validate and sanitise all user input with `joi` (reject unknown keys) at the route boundary before it reaches a service.
- Build MongoDB queries via the native driver's query object syntax, never by concatenating user input into query strings or `$where` expressions.
- Never log, persist, or return full subscription keys or tokens — only a `keyHint` (last 4 characters), per the sensitive data handling convention above.
- Use `Idempotency-Key` headers on endpoints that create resources.
- Authentication is internal-only: `x-user-id` via the `requireUser` pre-handler, `x-maintenance-token` for maintenance routes — the backend has no public ingress and does not implement its own sign-in flow.
- Only use approved MCP servers (see [Defra MCP guidance](https://defra.github.io/defra-ai-sdlc/pages/appendix/defra-mcp-guidance/)) — do not enable community or self-built MCP servers.

## Documentation

- Write JSDoc comments for exported functions (already an established convention above).
- Keep the README up to date with setup, run, and environment variable changes.
- Document breaking changes in PR descriptions.

## How Copilot should respond

- Follow conventions already in the codebase — check existing patterns first.
- Prefer modifying existing files over creating new ones when the change fits naturally.
- Provide minimal diffs touching only the necessary files; do not refactor unrelated code.
- Always include or update tests for changed behaviour.
- Keep solutions DRY: before adding new utilities, search `src/common/` and existing services for similar code.
- If a request conflicts with these instructions, or would use a discouraged library, skip tests, hardcode a secret, or break a quality gate — flag it explicitly and do not proceed silently.

## Licence

All code is published under the [Open Government Licence v3](../LICENCE) unless an exception is approved.
