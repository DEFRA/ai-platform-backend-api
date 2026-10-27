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
  - [GitOps operations](#gitops-operations)
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

### GitOps operations

A change to a team's GitOps file is an **operation**: one per request per file, stored in the `operations`
collection and shown on the team deployment entry as `operation {id, state, attempt, runUrl, commitSha, failureReason}`.
The backend never writes to GitHub. CDP lets one service operate on a queue, so each direction is a topic its producer
owns and a queue its consumer owns, subscribed by CDP with raw delivery (the queue body is the message, no SNS envelope).
The backend publishes **commands** (`submit`, `apply`, `reconcile`) to the FIFO topic `aip_gitops_commands` it owns;
the GitOps worker (`ai-platform-worker`) consumes its own queue `aip_gitops_commands_worker` subscribed to it, and
the `v2` workflows do the GitHub work. **Events** (`requested`, `committed`, `deploying`, `deployed`,
`checks-failed`, `deploy-failed`, `paused`, `resumed`) reach the backend's own queue `aip_gitops_events.fifo`,
which the backend reads: the worker's reconciler publishes to its topic `aip_gitops_events_worker` (subscribed to that
queue), and the workflows send straight to it through a federated identity (`sqs:SendMessage` only). Each queue has a
dead-letter queue (`-deadletter.fifo`, after 3 receives); the backend owns, and so can redrive, only the events queue's. The design is
[`async-operations-plan.md`](../ai-platform-discovery-docs/docs/async-operations-plan.md); the workflow interface is the
[GitOps contract](../ai-platform-infra/docs/gitops-contract.md).

| Part                                                                                                               | Role                                                                                                                                                                                                                            |
| :----------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`operation-state-machine.js`](src/operations/operation-state-machine.js)                                          | The one state table: `queued`, `requested`, `committed`, `deploying`, `deployed`, `verified`, `active` or `removed`, `checks-failed`, `deploy-failed`, `timed-out`. An event is applied only at a higher rank                   |
| [`operations-service.js`](src/operations/operations-service.js)                                                    | Takes the file's slot (one active and one waiting operation per file; later requests merge into the waiting one), builds the whole canonical document and writes the operation and its outbox entry in one document             |
| [`outbox-relay.js`](src/operations/outbox-relay.js)                                                                | Publishes outbox entries the request path did not (claimed by compare-and-set, lease 30 s), so an SNS outage never loses a command. `commandId` (UUIDv7) is the FIFO deduplication ID and is kept when an entry is republished  |
| [`events-consumer.js`](src/operations/events-consumer.js), [`events-handler.js`](src/operations/events-handler.js) | Long-poll the events queue, validate each event against the vendored schema, apply it. The handler is idempotent (`eventId` is the deduplication ID) and throws only for transient failures, which retry and then reach the DLQ |
| [`corroborator.js`](src/operations/corroborator.js)                                                                | Before acting on `checks-failed`, `deploy-failed`, `paused`, `resumed` or an unknown operation, reads the run with the read token and drops an event that does not match                                                        |
| [`deadline-sweeper.js`](src/operations/deadline-sweeper.js)                                                        | Every `GITOPS_SWEEP_INTERVAL_MS`, under a MongoDB lock, acts on overdue operations and due verification retries                                                                                                                 |

Deadlines run from entering a state: `requested` 10 minutes, `committed` 30, `deploying` 45, `deployed` 15. Past one, the sweeper
publishes `reconcile` (the worker reports what GitHub holds) and extends the deadline by 10 minutes; a second time with no
progress the operation is `timed-out`, keeping the file's slot until an event moves it on or a Platform Admin retries.
After `deployed` the backend verifies the team's resources through ARM (`PROVISIONING_MODE=live`) once in the handler,
then at 30, 60, 120 and 240 seconds, up to `GITOPS_VERIFY_MAX_ATTEMPTS`, before `deploy-failed` with
`operation-verify-failed`; verified, a team's credential is issued and the operation is `active`. A `verified` operation and
one that has ended but not yet freed its file carry a deadline and a pending `followUp`, so the sweeper or a redelivered
event completes the ending (freeing the slot, promoting the waiting request, the projection) if a restart or a lost write
interrupted it. An attributable apply
failure gets one fresh apply (attempt 2), then a revert (a child `team-file.revert` operation published after
`GITOPS_REVERT_GRACE_MS` unless the apply recovered) or an engineer alert (D14); a refusal as `stale-revision` or
`commit-conflict` is rebuilt from `main` and resubmitted up to `GITOPS_RESUBMIT_MAX` times.

An admin pauses an environment with `AIP_PAUSED` and `pause.yml`; the workflows' own read of the variable is authoritative
and the backend's `environmentControls` record only spares a dispatch that would be refused. A paused environment holds
automatic writes, retries and reverts (they keep their slot and show as Waiting), resubmitted on `resumed` or at
`GITOPS_DEADLINE_HELD_MS`.

**Local and mock mode.** `TENANT_ORCHESTRATOR=mock` (the default; prod refuses it) uses an in-memory publisher and a mock
worker that sends the events one stage at a time, `TEAM_DEPLOYMENT_MOCK_STAGE_DURATION_MS` apart, and a mock team file
reader (it serves a `research.json` with only `gpt-4o` deployed, as in infradev). It forces a failure for a requester whose
Entra object ID starts `entra:00000000-0000-0000-0001-` (`checks-failed`, nothing committed) or
`entra:00000000-0000-0000-0002-` (`deploy-failed`, not attributable, so final; an admin retry's second attempt succeeds),
and, for journey tests that sign in as real users, a request whose `purpose` contains `[mock:checks-failed]` or
`[mock:deploy-failed]`; the markers have no effect with `sqs`. `TENANT_ORCHESTRATOR=sqs` needs the commands topic ARN, the events queue URL and the
GitHub App, and `AWS_SQS_ENDPOINT` and `AWS_SNS_ENDPOINT` for the Floci topics and queues that `compose/floci/start.d/20-gitops-queues.sh` creates (see
[Docker Compose](#docker-compose)).

**Message contracts.** `src/contracts/aip-gitops/` holds the command and event JSON Schemas vendored from
`ai-platform-infra` at the ref in its `VERSION` file, validated with Ajv. They are additive-only and never edited by hand:
`npm run contracts:sync -- {ref}` downloads them and `npm run contracts:check` (in CI) fails on any difference.

**GitHub identity.** One App, `ai-platform-orchestrator`. The backend only reads: `createGithubAppClient` requires explicit
`repositoryNames` and `permissions`, refuses any permission outside `contents`, `actions` and `metadata` at `read`, and
refuses any request that is not a GET or HEAD, so the backend's token can read the catalogue (`ai-platform-infra`), team
files and `research.json` (`ai-platform-tenants`), pins (`ai-platform-deployments`) and run reports, and cannot write.
Dispatch is the worker's. The change needs no schema backfill: nothing was live, so the old states and fields are deleted,
not mapped.

A team's file takes one operation at a time, so a request made while another for the same team and
environment is in progress is stored as `queued` and submitted, its document built then, once that one ends.
`POST /v1/teams/{teamId}/deployments` takes `{modelSlugs: [...], environment}` (1 to 20 models) and
returns `{deployments}` in the order asked: one entry per model, all following the request's one operation. The request is all or nothing up
front (a model a team cannot have in that environment is refused as `400 model-not-eligible`, and one the team already
has as `409 deployment-exists` with `existing`; a model the team removed may be asked for again) and
idempotent by `Idempotency-Key`: a replay returns its entries and finishes any a crashed attempt did
not reach. One rule covers every tier: **no Global SKU (`name` starting `Global`), UK or EU regions
only** (`ALLOWED_REGIONS`: UK South/West, Sweden Central, North/West Europe). A team can have a model
when it is eligible, has a `team` SKU under that rule (regions from the SKU, else the model's) and lists
the environment ([`teamSkuOf` and `isTeamEligible`](src/services/catalogue-service.js));
research (on-your-own) credentials need the same of a `research` SKU (`researchSkuOf`, `isResearchEligible`)
**and** the model deployed in the research environment: an `active` deployment in that environment's
platform-owned `environments/{RESEARCH_ENVIRONMENT}/research.json` on `ai-platform-tenants`, matched by `slug`
([`research-deployments.js`](src/services/research-deployments.js); read through the team file reader,
cached for `RESEARCH_DEPLOYMENTS_CACHE_MS`). Otherwise issuing is `403 model-not-eligible` (not offered to
research) or `403 model-not-deployed` (offered, but not deployed there); a failed read of the file is
`502 research-deployments-unavailable`, never an empty or stale answer. `GET /v1/models?tier=team` (optionally
`&environment=`) and `?tier=research` list only those; the plain list is unchanged except that each model also
carries a flat boolean `researchAvailable` (research-eligible **and** deployed), so a page need not work it out,
and it too answers `502 research-deployments-unavailable` when the file cannot be read.
Each deployment's `progressSteps` are `{label, state, at}`: the third label names the model ("Setting up
GPT-4o in Azure"), and `at` is when a done step finished or the current one started (ISO time, from
the entry's `statusTimes`), null for one not reached.
Platform Admins
(users whose `roles` include `platform-admin`; nothing assigns it yet) can
`POST /v1/admin/team-deployments/{id}/retry` or `/reconcile` (403 for anyone else): `retry` publishes `submit` before
`committed` and `apply` after it (a fresh attempt from `deploy-failed`; a `timed-out` operation resumes from the state it
left), and `reconcile` asks the worker to report what GitHub holds.

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
(`teamDeployment.credential`). The maintenance sweep retries (at most once per 30 seconds, serialised with revocation under the credential's own lock)
while the team has no active credential and its latest attempt is unfinished, missing, or was revoked
before the newest activation (a revocation after it is left alone); an unfinished attempt's document
is reused, never duplicated. Any team member
can see the credential (`GET /v1/credentials`, `keyHint` only); only a team admin can reveal its
secret with a reason (`POST /v1/credentials/{id}/reveal`), rotate or revoke it. It covers
whatever the team's gateway grants there: its `allowedDeployments` is read from the team's deployments
on every response, never stored, so a removed model leaves the credential at once. A revoked
credential keeps what it covered when it was revoked; a later model activation creates a new one.

| Variable                               | Default                         | Purpose                                                                                                                                                                                                           |
| :------------------------------------- | :------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TENANT_ORCHESTRATOR`                  | `mock`                          | `mock` or `sqs`. Prod refuses `mock`; `sqs` needs the commands topic ARN, the events queue URL and the GitHub App (`GITHUB_CLIENT_ID` or `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`) |
| `TEAM_ENVIRONMENTS`                    | `infradev`                      | Comma-separated environments this instance may deploy a team's models to (D1): `infradev` on the CDP dev instance, `sandbox` on test; anything else is `403 environment-not-available`                            |
| `GITOPS_TENANTS_REPO`                  | `DEFRA/ai-platform-tenants`     | Team files, `environments/{env}/{slug}.json`                                                                                                                                                                      |
| `GITOPS_DEPLOYMENTS_REPO`              | `DEFRA/ai-platform-deployments` | Platform pins, `environments/{env}/platform.json`                                                                                                                                                                 |
| `GITOPS_COMMANDS_TOPIC_ARN`            | none                            | `aip_gitops_commands.fifo`, the backend-owned topic commands are published to; required for `sqs`                                                                                                                 |
| `GITOPS_EVENTS_QUEUE_URL`              | none                            | `aip_gitops_events.fifo`, the backend-owned queue events are read from; required for `sqs`                                                                                                                        |
| `AWS_SQS_ENDPOINT`, `AWS_SNS_ENDPOINT` | none                            | SQS and SNS endpoint overrides for local runs (Floci); unset on CDP. `AWS_REGION` defaults to `eu-west-2`                                                                                                         |
| `HANDLER_TIMEOUT_MS`                   | `30000`                         | How long the events handler may take for one message; the queue's visibility timeout (60 s) must stay above it                                                                                                    |
| `SQS_WAIT_TIME_SECONDS`                | `20`                            | Long-polling wait for the events queue                                                                                                                                                                            |
| `GITOPS_OUTBOX_SWEEP_MS`               | `2000`                          | How often the relay publishes outbox entries the request path did not                                                                                                                                             |
| `GITOPS_SWEEP_INTERVAL_MS`             | `15000`                         | How often the sweeper looks for overdue operations and due verification retries                                                                                                                                   |
| `GITOPS_RECONCILE_GRACE_MS`            | `600000`                        | How long an operation gets after a `reconcile` before it times out with no progress                                                                                                                               |
| `GITOPS_DEADLINE_REQUESTED_MS`         | `600000`                        | Deadline from entering `requested`                                                                                                                                                                                |
| `GITOPS_DEADLINE_COMMITTED_MS`         | `1800000`                       | Deadline from entering `committed`                                                                                                                                                                                |
| `GITOPS_DEADLINE_DEPLOYING_MS`         | `2700000`                       | Deadline from entering `deploying`                                                                                                                                                                                |
| `GITOPS_DEADLINE_DEPLOYED_MS`          | `900000`                        | Deadline from entering `deployed`, ARM verification included                                                                                                                                                      |
| `GITOPS_VERIFY_MAX_ATTEMPTS`           | `5`                             | How many times ARM may fail to confirm a deployed team before `deploy-failed` with `operation-verify-failed`; a Platform Admin retry starts the count again                                                       |
| `GITOPS_RESUBMIT_MAX`                  | `3`                             | How many times a `stale-revision` or `commit-conflict` write is rebuilt from `main` and resubmitted (after 10, 30 and 90 s) before it times out                                                                   |
| `GITOPS_REVERT_GRACE_MS`               | `300000`                        | How long a revert waits before it is published, in case the failed apply recovers                                                                                                                                 |
| `GITOPS_DEADLINE_HELD_MS`              | `1800000`                       | Deadline of an operation held while its environment is paused, doubling up to 4 hours                                                                                                                             |
| `GITOPS_HELD_ALARM_MS`                 | `3600000`                       | How long an operation may stay held or deferred before the alarm                                                                                                                                                  |
| `TEAM_DEFAULT_TOKENS_PER_MINUTE`       | `1000`                          | Gateway token limit a **new** team file starts with, until B17 agrees per-environment bounds                                                                                                                      |
| `TEAM_DEFAULT_REQUESTS_PER_MINUTE`     | `60`                            | Request limit a new team file starts with when the catalogue model states no `limitsDefault.requestsPerMinute`                                                                                                    |
| `AIP_ENVIRONMENTS`                     | `{}`                            | JSON keyed by environment name; ARM verification only accepts resources in that environment's subscription and resource group, and research keys are issued into the entry named by `RESEARCH_ENVIRONMENT`        |
| `RESEARCH_ENVIRONMENT`                 | `infradev`                      | The `AIP_ENVIRONMENTS` entry research keys are issued into; live mode refuses to start when it is missing or lacks `apimName` or `tenantsVault`                                                                   |
| `RESEARCH_DEPLOYMENTS_CACHE_MS`        | `60000`                         | How long the models deployed in that environment's `research.json` are cached, so listing models does not read GitHub per request (`0` turns the cache off)                                                       |

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

Every GitHub request sends `X-GitHub-Api-Version: 2026-03-10`, and each client gets its own installation token scoped to
one repository with read permissions only (see GitOps operations above). Reads are conditional on ETags and back off on
rate limits.

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
`20-gitops-queues.sh` mirrors CDP's GitOps messaging: the commands topic `aip_gitops_commands.fifo` (the backend's) with the
worker's queue `aip_gitops_commands_worker.fifo` subscribed, and the events topic `aip_gitops_events_worker.fifo` (the
worker's) with the backend's queue `aip_gitops_events.fifo` subscribed, all FIFO, content-based deduplication off, raw
delivery, and each queue with a dead-letter queue (`-deadletter.fifo`, 60 s visibility, redrive after 3 receives). The
backend runs with `TENANT_ORCHESTRATOR=mock` unless you start compose with `TENANT_ORCHESTRATOR=sqs`. Compose forwards the
messaging settings into the container with Floci defaults, so only the GitHub App credentials are needed from your shell:
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` and `GITHUB_APP_PRIVATE_KEY` (never put them in `compose.yml`). The defaults
are `GITOPS_COMMANDS_TOPIC_ARN=arn:aws:sns:eu-west-2:000000000000:aip_gitops_commands.fifo`, `GITOPS_EVENTS_QUEUE_URL=http://floci:4566/000000000000/aip_gitops_events.fifo`,
`AWS_SQS_ENDPOINT=http://floci:4566` and `AWS_SNS_ENDPOINT=http://floci:4566`; set any of them in your shell to override.
With Floci up on the host, `FLOCI_ENDPOINT=http://localhost:4566 npx vitest run src/adapters/sns` also runs the opt-in
test that publishes a command with the real SNS publisher and reads it, as the same JSON, from a subscribed queue (it
is skipped when `FLOCI_ENDPOINT` is not set, and CI does not run it).
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
