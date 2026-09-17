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

## Code Quality and Design Principles

- Apply SOLID principles pragmatically to JS modules (not just classes):
  - **Single responsibility**: routes validate and delegate; services own one area of business logic; adapters own one external integration. Don't let a service reach into another service's collection or an adapter leak business rules.
  - **Open/closed**: extend behaviour by adding new services/adapters/routes rather than editing a shared helper to special-case a new feature.
  - **Liskov substitution**: any adapter implementing a port (e.g. `CredentialIssuer`) must be a drop-in replacement for another implementation of that port — same inputs/outputs, no extra required side effects.
  - **Interface segregation**: ports expose only the methods callers need (e.g. `CredentialIssuer.issue()`), not a large multi-purpose interface.
  - **Dependency inversion**: services depend on port interfaces (`CredentialIssuer`) injected as parameters/defaults, never on a concrete adapter (e.g. the real Azure client) directly, so a mock or alternate implementation can be substituted without changing the service.
- **API layer is a RESTful JSON API**: model routes around resources and plural nouns (`/v1/models`, `/v1/credentials`), use the correct HTTP method per operation (`GET` read, `POST` create, `PATCH`/`POST .../renew` for partial updates or actions, `DELETE` remove), return the correct status code (`200`/`201`/`204`/`4xx`/`5xx`), set a `Location` header on `201 Created` responses, and always request/respond with JSON (`application/json`) — never HTML or plain text.

## Specifications

Feature and technical specifications live under [.github/specs/](./specs/README.md) — check there before making large changes for existing design docs.

### Using the shared MVP portal spec (backend scope only)

[.github/specs/mvp-portal-ui-api-scope.md](./specs/mvp-portal-ui-api-scope.md) is a copy of a cross-repo specification shared with the `ai-platform-frontend` repo — it documents the frontend, the backend and the overall architecture together, and is kept as a faithful, unannotated copy of the source document. **This repo is the backend service (`ai-platform-backend-api`) only.** When using this spec to plan or implement work here:

- Apply only the backend-relevant sections: `Backend structure`, `Domain model and MongoDB collections`, the "Backend" column in `UI and API orchestration` → `Responsibilities`, the backend rows in `Configuration` (`MONGO_URI`, `AZURE_*`, `APIM_*`, `RESEARCH_CREDENTIAL_TTL_DAYS`, `MAINTENANCE_TOKEN`, etc.), the backend rows/columns in `Delivery phases` and `Testing strategy`, and the backend-facing parts of `Cross-cutting requirements` (validation, audit, observability, no public ingress).
- Treat `API v1 contract` as the contract this service **implements and owns** — routes, request/response shapes, error codes, and status codes must match it exactly, since the frontend calls it as a black box.
- Do **not** implement anything under `Frontend structure`, Nunjucks views/GOV.UK component rendering, session/CSRF handling, or frontend-only environment variables (`API_BASE_URL`, `SESSION_CACHE_ENGINE`, frontend's own `ALLOWED_EMAIL_DOMAINS` copy) — those belong exclusively to the frontend repo.
- User journeys and architecture diagrams describe both services — read them for context on what the backend receives/returns, but only implement the backend (`BE`) side.
- If a task needs frontend behavior that doesn't exist yet, note it as a dependency instead of building it here.
