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
- [Development helpers](#development-helpers)
  - [MongoDB Locks](#mongodb-locks)
  - [Schema backfills](#schema-backfills)
  - [Proxy](#proxy)
- [Docker](#docker)
  - [Development image](#development-image)
  - [Production image](#production-image)
  - [Docker Compose](#docker-compose)
  - [Dependabot](#dependabot)
  - [SonarCloud](#sonarcloud)
- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Documentation

- [Implemented features](../ai-platform-frontend/docs/implemented-features.md) — what's been built
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
