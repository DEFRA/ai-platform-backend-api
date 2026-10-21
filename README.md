# ai-platform-backend-api

Core delivery platform Node.js Backend Template.

- [Documentation](#documentation)
- [Requirements](#requirements)
  - [Node.js](#nodejs)
- [Local development](#local-development)
  - [Setup](#setup)
  - [Development](#development)
  - [Testing](#testing)
  - [Production](#production)
  - [Npm scripts](#npm-scripts)
  - [Update dependencies](#update-dependencies)
  - [Formatting](#formatting)
    - [Windows prettier issue](#windows-prettier-issue)
- [API endpoints](#api-endpoints)
  - [People and identity](#people-and-identity)
- [Development helpers](#development-helpers)
  - [MongoDB Locks](#mongodb-locks)
  - [Schema backfills](#schema-backfills)
  - [Proxy](#proxy)
  - [GitOps tenant orchestrator](#gitops-tenant-orchestrator)
  - [Testing against live Azure resources (sandbox)](#testing-against-live-azure-resources-sandbox)
- [Docker](#docker)
  - [Development image](#development-image)
  - [Production image](#production-image)
  - [Docker Compose](#docker-compose)
  - [Dependabot](#dependabot)
  - [SonarCloud](#sonarcloud)
- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Documentation

- [Implemented features](../ai-platform-frontend/docs/plans/implemented/implemented-features.md) — what's been built
  so far across this repo and `ai-platform-frontend`, for new joiners.

## Requirements

### Node.js

Please install [Node.js](http://nodejs.org/) `>= v24` and [npm](https://nodejs.org/) `>= v11`. You will find it
easier to use the Node Version Manager [nvm](https://github.com/creationix/nvm)

To use the correct version of Node.js for this application, via nvm:

```bash
cd ai-platform-backend-api
nvm use
```

## Local development

### Setup

Install application dependencies:

```bash
npm install
```

### Git hooks

Install git hooks (optional)

```bash
npm run git:hooks
```

### Development

To run the application in `development` mode run:

```bash
npm run dev
```

`npm run dev` restarts on any change under `src/`, which loses the in-memory mock
vault. Use `npm run dev:nowatch` to run without the watcher.

### Testing

To test the application run:

```bash
npm run test
```

### Production

To mimic the application running in `production` mode locally run:

```bash
npm start
```

### Npm scripts

All available Npm scripts can be seen in [package.json](./package.json).
To view them in your command line run:

```bash
npm run
```

### Update dependencies

To update dependencies use [npm-check-updates](https://github.com/raineorshine/npm-check-updates):

> The following script is a good start. Check out all the options on
> the [npm-check-updates](https://github.com/raineorshine/npm-check-updates)

```bash
ncu --interactive --format group
```

### Formatting

#### Windows prettier issue

If you are having issues with formatting of line breaks on Windows update your global git config by running:

```bash
git config --global core.autocrlf false
```

## API endpoints

| Endpoint             | Description                    |
| :------------------- | :----------------------------- |
| `GET: /health`       | Health                         |
| `GET: /example    `  | Example API (remove as needed) |
| `GET: /example/<id>` | Example API (remove as needed) |

### People and identity

> [!IMPORTANT]
> A person is keyed on their Entra object ID and tenant ID (`oid`, `tid`), which `POST /v1/users`
> receives at every sign-in; a unique index on both holds that key. **Email is not unique**: it is
> display only and mutable (Microsoft advises never to key data on it), so two `users` records can
> share an email, for example a leaver who returns with a new object ID. A record with no `oid` (an
> invited member) binds to the first sign-in with its email. Every GitOps change names its requester as
> `entra:{oid}`, so look people up by `oid`, never by email (direction 14 October 2026).

> [!IMPORTANT]
> A team carries an immutable `slug`, derived from its name on `POST /v1/teams` and made unique with a
> numbered suffix when two names derive the same one. It names the team's GitOps file
> (`environments/{env}/{slug}.json`), its gateway API path (`/{slug}`) and its model deployments
> (`{slug}-{model}`), so it is never regenerated when a team is renamed. Every `/v1/teams/{id}/...` route
> takes the team's slug or its id, and `GET /v1/teams/{id}` also lists `environments`: each environment
> the team has a tenant file in, with its gateway `limits`. A team's first request in a new environment
> copies the limits of its first environment.

> [!IMPORTANT]
> A team also carries a three-character `serviceCode` (`^[A-Z0-9]{3}$`, stored upper case), required
> on `POST /v1/teams` and changeable by an admin with `PATCH /v1/teams/{id}`, which also takes a
> `description` (trimmed, at most 500 characters, may be empty). Adding a member takes a `role`
> (`admin` or `user`, default `user`), admins only. The service code attributes the
> team's AI use to its service for chargeback and reaches Azure as a resource tag. Every change goes
> through the `ServiceCodeVerifier` port, whose only adapter today is the mock
> (`SERVICE_CODE_KNOWN_CODES`, empty by default), so `verified` stays `false` until an authoritative
> CDP or Cloud Centre of Excellence source is agreed and a real adapter replaces it - the prod
> mock-refusal guard the other ports have belongs with that adapter.

## Development helpers

### MongoDB Locks

If you require a write lock for Mongo you can acquire it via `server.locker` or `request.locker`:

```javascript
async function doStuff(server) {
  const lock = await server.locker.lock('unique-resource-name')

  if (!lock) {
    // Lock unavailable
    return
  }

  try {
    // do stuff
  } finally {
    await lock.free()
  }
}
```

Keep it small and atomic.

You may use **using** for the lock resource management.
Note test coverage reports do not like that syntax.

```javascript
async function doStuff(server) {
  await using lock = await server.locker.lock('unique-resource-name')

  if (!lock) {
    // Lock unavailable
    return
  }

  // do stuff

  // lock automatically released
}
```

Helper methods are also available in `/src/helpers/mongo-lock.js`.

### Schema backfills

MongoDB has no enforced schema, so a schema change is really two steps: ship code that reads/writes
the new shape (tolerating old documents), then update any already-persisted documents to match. The
second step is a **backfill** - a one-off data migration registered in
[`src/common/backfills/registry.js`](src/common/backfills/registry.js) and applied by
[`runBackfills`](src/common/backfills/run-backfills.js), which runs automatically on every server
start (alongside `createIndexes`/`seedModels` in `src/plugins/mongodb.js`).

Each registry entry is applied **at most once per environment**: `runBackfills` claims an entry by
inserting its `id` into the `schemaMigrations` collection (a unique key, so if two instances start at
the same time only one wins the race and runs it), calls `run(db)`, then records `appliedAt` and the
returned result. On every later start the entry is already claimed, so it's skipped - safe to leave
shipped entries in the registry permanently as a changelog of what has run.

**Example**: say a new `credentials` field `issuedVia` is added, and existing documents predate it and
need it backfilled to `'legacy'`. Add an entry to `registry.js`:

```javascript
export const backfillRegistry = [
  {
    id: '2026-10-01-credentials-issued-via-legacy',
    description: "Sets issuedVia: 'legacy' on credentials docs missing it",
    async run(db) {
      const { modifiedCount } = await db
        .collection('credentials')
        .updateMany(
          { issuedVia: { $exists: false } },
          { $set: { issuedVia: 'legacy' } }
        )

      return { modifiedCount }
    }
  }
]
```

Notes on writing a new entry:

- `id` should be unique and sortable (a date prefix works well) - it's both the claim key and the
  permanent record of what ran.
- `run` only needs to be idempotent against documents it hasn't reached yet, not against re-runs of
  the whole backfill (the `schemaMigrations` claim already prevents that) - a narrowing filter like
  `{ field: { $exists: false } }` is enough.
- Never assume every document is already in the new shape; code that reads the field should still
  fall back (e.g. `doc.issuedVia ?? 'legacy'`) until you're confident the backfill has run everywhere,
  then remove the fallback in a later change.

A template entry marked `EXAMPLE - remove as required` is included in `registry.js` showing the same
shape against the `example-data` collection.

### Proxy

We are using forward-proxy which is set up by default. Services are automatically configured with the proxy environment variables when deployed.

Node.js 24 uses these variables to route outbound HTTP(S) requests through the proxy:

NODE_USE_ENV_PROXY=1
HTTPS_PROXY=...
NO_PROXY=...

No additional proxy configuration is required in the service.

### Gateways

Every model is reached through Azure API Management, whichever cloud hosts it. A catalogue model's
`hosting` (`platform`: `foundry`, `bedrock` or `direct`, plus `cloud` or `provider`) says where it
runs; it is not a gateway. The offering's `gateway` (today only `azure-apim`) selects the issuer and
vault that issue and store its credentials. `PROVISIONING_MODE` is only
`mock` (fake keys, in-memory vault, whatever the model's gateway) or `live`. In `live` mode
`ENABLED_GATEWAYS` (comma-separated, default `azure-apim`; renamed from `ENABLED_ADAPTERS`) lists the
gateways this environment can
use; startup fails if an enabled gateway's config is missing, and a model whose gateway isn't
enabled is refused with `501 gateway-not-enabled`. A credential records the `issuerKey` that
minted it, and its renew/rotate/revoke/reveal use that issuer and its matching vault.
`MOCK_TIERS` (comma-separated `research`/`team`, default empty, refused in prod) keeps the named
tiers on the mock issuer and vault even in `live` mode, e.g. `MOCK_TIERS=team` to demo the team
tier without a real team gateway while the research tier uses the real gateways. Research
credentials are time-bound APIM subscription keys. The team tier is OAuth only (a client secret or
a federated credential, local development included), and no
gateway issues team OAuth credentials yet, so in `live` mode it needs `MOCK_TIERS=team` and is
otherwise refused with `501 gateway-not-enabled`.

The catalogue sync reads only the `hosting`/`gateway` offering shape (`ai-platform-infra` `v0.2.0`
onwards) and stores it nested on each model. An offering without `hosting.platform` and `gateway`,
or a duplicate offering id, skips the sync; a model whose offering is unknown is skipped.

No `bedrock` offering ships yet: how API Management authenticates to Bedrock without long-lived AWS
keys is an open design question. A Bedrock or direct-API model would still be an offering behind
APIM, not a new gateway. A genuinely new gateway needs its issuer and vault adapters added to
`issuerFactories` and `vaultFactories` in `credential-issuer-registry.js` /
`credential-vault-registry.js`, and its required config keys added to
`REQUIRED_CONFIG_BY_GATEWAY` in `config.js`. Nothing in the services changes.

### GitOps tenant orchestrator

Team deployments go through the `TenantOrchestrator` port
([`src/adapters/tenant-orchestrator.js`](src/adapters/tenant-orchestrator.js)). `mock` walks the
GitOps states on a timer. `github` follows the
[GitOps contract](../ai-platform-infra/docs/gitops-contract.md): it dispatches `submit.yml` with the
whole canonical document (never committing), then polls the submit run, the `op/{operationId}` pull
request and `validate-desired-state / validate`, the GitHub Deployment and the apply's run report, and confirms the
team's resources through ARM (`PROVISIONING_MODE=live`) before `active`. An apply failure gets one
fresh apply, then a revert or an engineer alert (D14); a failed check gets `abandon`. Reverts and
abandons are polled to their end; one that fails is audited and logged for an engineer, never retried,
and a failed revert's pull request stays open, keeping the team file locked, until the engineer acts
(direction 14 October 2026).
A team's file takes one operation at a time, so a request made while another for the same team and
environment is still in progress (or being reverted or abandoned) is stored as `queued` and dispatched,
its document built then, once that one ends.
`POST /v1/teams/{teamId}/deployments` takes `{modelSlugs: [...], environment}` (1 to 20 models) and
returns `{deployments}` in the order asked: one entry and operation per model, the first in flight
and the rest queued, so one that fails never holds back the others. The request is all or nothing up
front (a model a team cannot have in that environment is refused as `400 model-not-eligible`, and one the team already
has as `409 deployment-exists` with `existing`; a model the team removed may be asked for again) and
idempotent by `Idempotency-Key`: a replay returns its entries and finishes any a crashed attempt did
not reach. A team can have a model when it is eligible, has a `team` SKU whose regions (else the
model's) are all in the UK, and lists the environment ([`teamSkuOf` and `isTeamEligible`](src/services/catalogue-service.js));
`GET /v1/models?tier=team` (optionally `&environment=`) lists only those, and the plain list is unchanged.
Each deployment's `progressSteps` are `{label, state, at}`: the third label names the model ("Setting up
GPT-4o in Azure"), and `at` is when a done step finished or the current one started (ISO time, from
the entry's `statusTimes`), null for one not reached.
Platform Admins
(users whose `roles` include `platform-admin`; nothing assigns it yet) can
`POST /v1/admin/team-deployments/{id}/retry` or `/reconcile`.

The document itself is built by
[`team-desired-state.js`](src/services/team-desired-state.js) (WS6), always from the file `main`
holds now rather than from the portal's own record, since the file is written whole and an engineer
or a revert may have changed it: the model is added to `deployments[]` and
`gateway.allowedDeployments`, `revision` is the file's plus one, and the team's federations,
external clients and agreed limits are carried over untouched. A new file starts at revision 1 with
the catalogue's team SKU, that environment's default capacity and the default limits below. The
team needs a three-character `serviceCode` first, or the request is refused with
`409 service-code-required`. Its tests validate what it builds against the infra team schema, copied
under `src/common/fixtures/gitops/ai-platform-infra/`.

A team admin removes a model with `DELETE /v1/teams/{teamId}/deployments/{id}` (design C `#actions`):
the file is submitted whole without the model and its grant, as a `remove` operation tracked on the
entry like a revert, and the next apply destroys the deployment. The entry is `removing` (202) until
that apply has run, then `removed` with the grant withdrawn, or `active` again with a failure reason
if the removal failed; a model that never reached `main` is marked `removed` at once (200). A
deployment still being set up is refused with `409 deployment-in-progress`, and one whose team file
another operation holds with `409 team-file-busy`.

A team's credential (one per team per environment) is created when the team's first model in that
environment turns `active`, under the lock `team-credential:{teamId}:{environment}`: its secret goes
straight to the vault and is never returned, and `POST /v1/credentials` no longer issues team
credentials (only `tier: research`; `team` is refused with `400`). A later model in the same
environment reuses it, and a different environment gets its own. If creating it fails (for example
no gateway issues team credentials in `live` mode without `MOCK_TIERS=team`, or the vault write
fails) the activation stands and the failure is logged and audited against the deployment
(`teamDeployment.credential`). The maintenance sweep, and any later poll of an active deployment,
retries (at most once per poll interval, serialised with revocation under the credential's own lock)
while the team has no active credential and its latest attempt is unfinished, missing, or was revoked
before the newest activation (a revocation after it is left alone); an unfinished attempt's document
is reused, never duplicated. Any team member
can see the credential (`GET /v1/credentials`, `keyHint` only); only a team admin can reveal its
secret with a reason (`POST /v1/credentials/{id}/reveal`), rotate or revoke it. It covers
whatever the team's gateway grants there: its `allowedDeployments` is read from the team's deployments
on every response, never stored, so a removed model leaves the credential at once. A revoked
credential keeps what it covered when it was revoked; a later model activation creates a new one.

| Variable                           | Default                         | Purpose                                                                                                                                                                                                    |
| :--------------------------------- | :------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TENANT_ORCHESTRATOR`              | `mock`                          | `mock` or `github`. Prod refuses `mock`; `github` needs the GitHub App (`GITHUB_CLIENT_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`)                                                        |
| `TEAM_ENVIRONMENTS`                | `infradev`                      | Comma-separated environments this instance may deploy a team's models to (D1): `infradev` on the CDP dev instance, `sandbox` on test; anything else is `403 environment-not-available`                     |
| `GITOPS_TENANTS_REPO`              | `DEFRA/ai-platform-tenants`     | Team files, `environments/{env}/{slug}.json`                                                                                                                                                               |
| `GITOPS_DEPLOYMENTS_REPO`          | `DEFRA/ai-platform-deployments` | Platform pins, `environments/{env}/platform.json`                                                                                                                                                          |
| `GITOPS_POLL_MIN_INTERVAL_MS`      | `30000`                         | Minimum gap between two GitHub or ARM polls of one operation                                                                                                                                               |
| `GITOPS_CLAIM_LEASE_MS`            | `600000`                        | How long a claimed retry, revert or abandon waits for its dispatch before another poll may claim it again                                                                                                  |
| `TEAM_DEFAULT_TOKENS_PER_MINUTE`   | `1000`                          | Gateway token limit a **new** team file starts with, until B17 agrees per-environment bounds                                                                                                               |
| `TEAM_DEFAULT_REQUESTS_PER_MINUTE` | `60`                            | Request limit a new team file starts with when the catalogue model states no `limitsDefault.requestsPerMinute`                                                                                             |
| `AIP_ENVIRONMENTS`                 | `{}`                            | JSON keyed by environment name; ARM verification only accepts resources in that environment's subscription and resource group, and research keys are issued into the entry named by `RESEARCH_ENVIRONMENT` |
| `RESEARCH_ENVIRONMENT`             | `infradev`                      | The `AIP_ENVIRONMENTS` entry research keys are issued into; live mode refuses to start when it is missing or lacks `apimName` or `tenantsVault`                                                            |

```json
{
  "infradev": {
    "subscriptionId": "00000000-0000-0000-0000-000000000000",
    "resourceGroup": "rg-placeholder",
    "apimName": "apim-placeholder",
    "foundryAccounts": ["aif-placeholder"],
    "tenantsVault": "kv-placeholder"
  }
}
```

Every GitHub request sends `X-GitHub-Api-Version: 2026-03-10`, and each use gets its own
installation token: Actions write on one repository to dispatch, and Actions, Checks, Contents,
Deployments and Pull requests read to poll. Polls are conditional on ETags, at most one per
operation per interval, back off on rate limits and skip finished operations; the maintenance
scheduler also sweeps operations nobody is watching.

### Testing against live Azure resources

By default the credential issuer and vault run in-memory (`PROVISIONING_MODE=mock`, the default) -
no Azure access needed. To run locally against **real** resources, create a `.env` file in the
repo root (already gitignored; `npm run dev`'s `--env-file-if-exists=.env` loads it automatically -
no other wiring needed) with:

| Variable                  | Value                                                                           |
| :------------------------ | :------------------------------------------------------------------------------ |
| `PROVISIONING_MODE`       | `live` (`azure` is a deprecated alias and still works)                          |
| `AZURE_ARM_TENANT_ID`     | The ARM app registration's tenant ID                                            |
| `AZURE_ARM_CLIENT_ID`     | The ARM app registration's client ID                                            |
| `AZURE_ARM_CLIENT_SECRET` | The ARM app registration's client secret                                        |
| `RESEARCH_ENVIRONMENT`    | The `AIP_ENVIRONMENTS` entry research keys are issued into (default `infradev`) |
| `AIP_ENVIRONMENTS`        | JSON as in the table above; the entry must carry `apimName` and `tenantsVault`  |

The subscription, resource group, API Management instance and Key Vault the research tier uses are
all read from the `AIP_ENVIRONMENTS` entry named by `RESEARCH_ENVIRONMENT` - there are no separate
variables for them, and the backend refuses to start in live mode when that entry is missing.
Each research credential records the environment it was issued in, and every later renew, rotate,
revoke, reveal and expiry acts on **that** environment's instance and vault, not the configured
one. To keep credentials issued before a move working, leave the old environment in
`AIP_ENVIRONMENTS`: credentials issued before `environment` was persisted count as `sandbox`
(the hand-built resources), so a deployment that still holds any needs a `sandbox` entry until they
have been revoked or retired (an expired key can still be renewed or revoked, which needs the entry). The scheduled sweep also logs a warning for any API Management subscription in the
research environment that is not a `research-*` key on the research API.

`armAuth.authMethod` (`AZURE_ARM_AUTH_METHOD`) defaults to `client-secret`, which is the only
method available locally - there is no AWS STS to federate a token from outside CDP. Every deployed
CDP environment instead sets `AZURE_ARM_AUTH_METHOD=federated`, which exchanges a short-lived AWS
STS web identity token (via `@defra/hapi-auth-oidc`'s `WebIdentityTokenProvider`) for an Entra
token through a `ClientAssertionCredential` - no client secret is read or needed in that mode. Both
methods authenticate as the same `armAuth.clientId` app registration and are interchangeable per
environment via config only; see `azure-credential.js` for the credential construction and
`AZURE_ARM_FEDERATED_AUDIENCE` (default `api://AzureADTokenExchange`) for the federated credential's
configured audience.

`APIM_RESEARCH_API_ID` needs no override - its `research` default matches the platform-owned
`research` API. `CATALOGUE_SOURCE` can stay on its `file` default for a smoke test of credential
issuing: the seed fixture carries the research model slugs.

**Issuing, rotating, revoking and revealing a credential only talks to ARM
(`management.azure.com`) and Key Vault (`{vault}.vault.azure.net`) - both public management-plane
endpoints reachable from any normal machine.** Calling the model itself goes through a third,
separate endpoint - the `research` API's own gateway, the API Management instance's hostname.
While the platform runs with public access (`network.mode: public-minimal`) that is reachable from
an ordinary machine too, so the full loop - issue a credential, call the model with it in
Postman/curl, reveal it again later, rotate or revoke it - is testable from a normal dev machine.
Below, `<gateway-host>` is the environment's API Management gateway hostname.

A minimal smoke test once the env vars above are set and `npm run dev` is running:

```bash
# Issue a credential - creates a real APIM subscription and a real Key Vault secret
curl -s -X POST http://localhost:3001/v1/credentials \
  -H 'x-user-id: smoke-test-user' -H "idempotency-key: $(uuidgen)" \
  -H 'Content-Type: application/json' -d '{"modelSlug": "gpt-4o"}'
```

Take the `secret` from that response and call the model directly against the gateway (this is the
request to import into Postman - `POST`, these two headers, the body below):

```bash
# chat-completions operation - {deployment-id} is the deployment name, e.g. gpt-4o
curl -s -X POST "https://<gateway-host>/research/openai/deployments/gpt-4o/chat/completions?api-version=2024-05-01-preview" \
  -H "Ocp-Apim-Subscription-Key: <secret>" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'

# responses operation - model is a body field, not a URL segment, and needs a newer api-version
curl -s -X POST "https://<gateway-host>/research/openai/responses?api-version=2025-03-01-preview" \
  -H "Ocp-Apim-Subscription-Key: <secret>" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","input":"hello"}'
```

Allowed `{deployment-id}`/`model` values are the names in the environment's platform-owned
`research.json` (`allowedDeployments`); anything else, e.g. the excluded `text-embedding-ada-002`,
returns `403 model-not-granted`, and no key returns `401`.

```bash
# Reveal it again later (replace {id} with the credential _id from the issue response above)
curl -s -X POST http://localhost:3001/v1/credentials/{id}/reveal \
  -H 'x-user-id: smoke-test-user' -H 'Content-Type: application/json' \
  -d '{"reason": "Smoke testing the live sandbox"}'

# Revoke it - deletes the APIM subscription and soft-deletes the Key Vault secret
curl -s -X DELETE http://localhost:3001/v1/credentials/{id} -H 'x-user-id: smoke-test-user'
```

Verify independently in the Azure portal (or `az rest`/`az keyvault secret list`) that the APIM
subscription and Key Vault secret actually appeared and disappeared, rather than trusting only the
API's own response.

## Docker

Build:

```bash
docker build --no-cache --tag ai-platform-backend-api .
```

Run:

```bash
docker run -e PORT=3001 -p 3001:3001 ai-platform-backend-api
```

### Docker Compose

A local environment with:

- Floci for AWS services (S3, SQS, SNS etc)
- Redis
- MongoDB
- This service.
- A commented out frontend example.

```bash
docker compose up --build -d
```

Mock AWS resources can be created when Floci starts up by editing the scripts in `./compose/floci/start.d/`.
MongoDB records can also be created when Mongo starts by editing the scripts in `./compose/mongo/`.

### Dependabot

We have added an example dependabot configuration file to the repository. You can enable it by renaming
the [.github/example.dependabot.yml](.github/example.dependabot.yml) to `.github/dependabot.yml`

### SonarCloud

Instructions for setting up SonarCloud can be found in [sonar-project.properties](./sonar-project.properties)

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government license v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
