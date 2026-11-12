import { MongoClient } from 'mongodb'

import { projectOperation } from '#/operations/operation-projection.js'

const DATABASE = 'federation-projection-test'
const AT = '2026-11-12T12:00:00.000Z'
const ADD = {
  kind: 'federation',
  entryId: 'fed-1',
  change: 'add',
  name: 'beta-api',
  federation: { host: 'cdp', name: 'beta-api', service: 'beta-api' }
}
const CHANGE = { ...ADD, change: 'change' }
const REMOVE = { ...ADD, change: 'remove' }

function operationAt(state, items, overrides = {}) {
  return {
    _id: '0193a000-0000-7000-8000-0000000abcde',
    teamId: 'team-1',
    environment: 'infradev',
    state,
    stateVersion: 5,
    attempt: 1,
    items,
    gitops: {},
    ...overrides
  }
}

describe('projecting an operation onto the federations of a team document', () => {
  let client
  let db

  async function seed(federations, extra = {}) {
    await db.collection('teamDeployments').deleteMany({})
    await db.collection('teamDeployments').insertOne({
      teamId: 'team-1',
      environment: 'infradev',
      deployments: [],
      federations,
      ...extra
    })
  }

  async function entry(id = 'fed-1') {
    const doc = await db
      .collection('teamDeployments')
      .findOne({ teamId: 'team-1', environment: 'infradev' })

    return doc.federations.find((federation) => federation.id === id)
  }

  const fresh = (overrides = {}) => ({
    id: 'fed-1',
    name: 'beta-api',
    host: 'cdp',
    service: 'beta-api',
    status: 'setting-up',
    statusTimes: {},
    ...overrides
  })

  beforeAll(async () => {
    client = await MongoClient.connect(process.env.MONGO_URI)
    db = client.db(DATABASE)
  })

  afterAll(async () => {
    await client.db(DATABASE).dropDatabase()
    await client.close()
  })

  describe.each([
    ['an addition', ADD, 'failed', 'failed'],
    // A change that failed before it committed leaves the application as it
    // was, still federated; one that failed in its deploy had committed.
    ['a change', CHANGE, 'ready', 'failed']
  ])('%s', (_name, item, failedStatus, deployFailedStatus) => {
    test.each([
      ['queued', 'setting-up'],
      ['requested', 'setting-up'],
      ['committed', 'setting-up'],
      ['deploying', 'setting-up'],
      ['deployed', 'setting-up'],
      ['verified', 'setting-up'],
      ['active', 'ready'],
      ['checks-failed', failedStatus],
      ['deploy-failed', deployFailedStatus],
      ['timed-out', failedStatus]
    ])('in the state %s shows %s', async (state, status) => {
      await seed([fresh({ status: 'ready' })])

      await projectOperation(db, operationAt(state, [item]))

      expect((await entry()).status).toBe(status)
    })
  })

  describe('a change', () => {
    const pending = {
      name: 'new-api',
      service: 'new-api',
      trustKey: 'CDP service new-api'
    }
    const changing = (extra = {}) =>
      fresh({
        trustKey: 'CDP service beta-api',
        pending,
        status: 'setting-up',
        ...extra
      })

    test('keeps the old definition while it is set up', async () => {
      await seed([changing()])

      await projectOperation(db, operationAt('deploying', [CHANGE]))

      expect(await entry()).toMatchObject({
        name: 'beta-api',
        service: 'beta-api',
        trustKey: 'CDP service beta-api',
        pending
      })
    })

    test('applies the new definition once it is active, and no longer holds it as pending', async () => {
      await seed([changing()])

      await projectOperation(db, operationAt('active', [CHANGE]))

      const applied = await entry()

      expect(applied).toMatchObject({
        name: 'new-api',
        service: 'new-api',
        trustKey: 'CDP service new-api',
        status: 'ready',
        pending: null
      })
    })

    test('applies an Azure application’s new name and principal ID', async () => {
      await seed([
        {
          id: 'fed-1',
          name: 'old-app',
          host: 'azure',
          principalId: 'a',
          trustKey: 'issuer a',
          status: 'setting-up',
          statusTimes: {},
          pending: { name: 'new-app', principalId: 'b', trustKey: 'issuer b' }
        }
      ])

      await projectOperation(db, operationAt('active', [CHANGE]))

      expect(await entry()).toMatchObject({
        name: 'new-app',
        principalId: 'b',
        trustKey: 'issuer b'
      })
    })

    test('that failed leaves the application as it was, ready, with the reason, and holds the pending one for a recovery', async () => {
      await seed([changing()])

      await projectOperation(
        db,
        operationAt('checks-failed', [CHANGE], {
          error: { code: 'operation-checks-failed', message: 'Not valid' }
        })
      )

      expect(await entry()).toMatchObject({
        name: 'beta-api',
        service: 'beta-api',
        status: 'ready',
        failureReason: 'Not valid',
        pending
      })
    })

    test('that recovers from a timeout applies the new definition then', async () => {
      await seed([changing()])

      await projectOperation(db, operationAt('timed-out', [CHANGE]))
      await projectOperation(
        db,
        operationAt('active', [CHANGE], { stateVersion: 7 })
      )

      expect(await entry()).toMatchObject({ name: 'new-api', status: 'ready' })
    })

    test('that failed in its deploy had committed: the new definition shows, failed', async () => {
      await seed([changing()])

      await projectOperation(db, operationAt('deploy-failed', [CHANGE]))

      expect(await entry()).toMatchObject({
        name: 'new-api',
        service: 'new-api',
        status: 'failed',
        pending: null
      })
    })

    test('with nothing pending changes only the status', async () => {
      await seed([fresh({ status: 'setting-up' })])

      await projectOperation(db, operationAt('active', [CHANGE]))

      expect(await entry()).toMatchObject({
        name: 'beta-api',
        status: 'ready'
      })
    })
  })

  describe('a removal', () => {
    test.each([
      ['requested', 'removing'],
      ['committed', 'removing'],
      ['deploying', 'removing'],
      ['deployed', 'removing'],
      ['verified', 'removing'],
      ['active', 'removed'],
      ['removed', 'removed'],
      ['checks-failed', 'ready'],
      ['deploy-failed', 'ready'],
      ['timed-out', 'ready']
    ])('in the state %s shows %s', async (state, status) => {
      await seed([fresh({ status: 'ready' })])

      await projectOperation(db, operationAt(state, [REMOVE]))

      expect((await entry()).status).toBe(status)
    })

    test('that failed says the application is still federated and quotes the reference', async () => {
      await seed([fresh({ status: 'removing' })])

      await projectOperation(db, operationAt('deploy-failed', [REMOVE]))

      expect((await entry()).failureReason).toMatch(
        /still federated.*AIP-ABCDE/
      )
    })
  })

  test('records the operation, its run and why an addition failed', async () => {
    await seed([fresh()])

    await projectOperation(
      db,
      operationAt('checks-failed', [ADD], {
        error: { code: 'operation-checks-failed', message: 'Not valid' },
        gitops: { submitRunUrl: 'https://github.com/DEFRA/x/actions/runs/1' }
      })
    )

    expect(await entry()).toMatchObject({
      status: 'failed',
      failureReason: 'Not valid',
      operationId: '0193a000-0000-7000-8000-0000000abcde',
      operation: {
        state: 'checks-failed',
        runUrl: 'https://github.com/DEFRA/x/actions/runs/1'
      },
      projectedVersion: 5
    })
  })

  test('has no failure reason for an addition that is going well', async () => {
    await seed([fresh()])

    await projectOperation(db, operationAt('deploying', [ADD]))

    expect((await entry()).failureReason).toBeNull()
  })

  test('keeps the time each status was first reached', async () => {
    await seed([fresh({ statusTimes: { 'setting-up': AT } })])

    await projectOperation(db, operationAt('deploying', [ADD]))
    await projectOperation(
      db,
      operationAt('active', [ADD], { stateVersion: 6 })
    )

    const { statusTimes } = await entry()

    expect(statusTimes['setting-up']).toBe(AT)
    expect(statusTimes.ready).toEqual(expect.any(String))
  })

  test('never lets a slower projection of the same operation overwrite a newer one', async () => {
    await seed([fresh()])

    await projectOperation(
      db,
      operationAt('active', [ADD], { stateVersion: 6 })
    )
    await projectOperation(
      db,
      operationAt('deploying', [ADD], { stateVersion: 4 })
    )

    expect((await entry()).status).toBe('ready')
  })

  test('takes a newer operation at once, whatever the version of the last', async () => {
    await seed([fresh({ operationId: 'older', operation: { id: 'older' } })])

    await projectOperation(
      db,
      operationAt('requested', [CHANGE], { stateVersion: 0 })
    )

    expect((await entry()).operationId).toBe(
      '0193a000-0000-7000-8000-0000000abcde'
    )
  })

  test('leaves other applications, the models and an item with no entry alone', async () => {
    await seed(
      [fresh(), fresh({ id: 'fed-2', name: 'other', service: 'other' })],
      {
        deployments: [{ id: 'dep-1', modelSlug: 'gpt-4o', status: 'active' }]
      }
    )

    await projectOperation(
      db,
      operationAt('active', [ADD, { ...ADD, entryId: 'no-such-entry' }])
    )

    expect((await entry()).status).toBe('ready')
    expect((await entry('fed-2')).status).toBe('setting-up')

    const doc = await db.collection('teamDeployments').findOne({})

    expect(doc.deployments[0].status).toBe('active')
  })

  test('does nothing for an operation with no application item, no document or no entry', async () => {
    await seed([fresh()])

    await projectOperation(
      db,
      operationAt('active', [
        { entryId: 'dep-9', modelSlug: 'gpt-4o', change: 'add' }
      ])
    )
    await projectOperation(
      db,
      operationAt('active', [ADD], { teamId: 'other' })
    )
    await projectOperation(
      db,
      operationAt('active', [{ ...ADD, entryId: 'missing' }])
    )

    expect((await entry()).status).toBe('setting-up')
  })

  test('works on a document that holds no applications yet', async () => {
    await seed(undefined)

    await expect(
      projectOperation(db, operationAt('active', [ADD]))
    ).resolves.toBeUndefined()
  })
})
