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
const OLDER = '0193a000-0000-7000-8000-000000000001'
const NEWER = '0193b000-0000-7000-8000-000000000001'

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

    test.each([['checks-failed'], ['timed-out']])(
      'of a failed addition that never committed stays failed in the state %s, not ready',
      async (state) => {
        await seed([changing({ statusBefore: 'failed' })])

        await projectOperation(db, operationAt(state, [CHANGE]))

        expect(await entry()).toMatchObject({
          name: 'beta-api',
          status: 'failed',
          pending
        })
      }
    )

    test('of a ready application restores it to ready when its checks fail', async () => {
      await seed([changing({ statusBefore: 'ready' })])

      await projectOperation(db, operationAt('checks-failed', [CHANGE]))

      expect((await entry()).status).toBe('ready')
    })

    test.each([['committed'], ['deploying'], ['deployed'], ['verified']])(
      'that timed out after it committed (it left %s) shows the new definition, failed, with nothing pending',
      async (leftState) => {
        await seed([changing()])

        await projectOperation(
          db,
          operationAt('timed-out', [CHANGE], { leftState })
        )

        expect(await entry()).toMatchObject({
          name: 'new-api',
          service: 'new-api',
          trustKey: 'CDP service new-api',
          status: 'failed',
          pending: null
        })
      }
    )

    test('that timed out with a commit recorded shows the new definition, failed', async () => {
      await seed([changing()])

      await projectOperation(
        db,
        operationAt('timed-out', [CHANGE], {
          leftState: 'requested',
          gitops: { commitSha: 'a'.repeat(40) }
        })
      )

      expect(await entry()).toMatchObject({ name: 'new-api', status: 'failed' })
    })

    test.each([['queued'], ['requested']])(
      'that timed out before it committed (it left %s) keeps the old definition and the pending one',
      async (leftState) => {
        await seed([changing()])

        await projectOperation(
          db,
          operationAt('timed-out', [CHANGE], { leftState })
        )

        expect(await entry()).toMatchObject({
          name: 'beta-api',
          status: 'ready',
          pending
        })
      }
    )

    test('that timed out after it committed and then recovered is ready with the new definition', async () => {
      await seed([changing()])

      await projectOperation(
        db,
        operationAt('timed-out', [CHANGE], { leftState: 'deploying' })
      )
      await projectOperation(
        db,
        operationAt('active', [CHANGE], { stateVersion: 7 })
      )

      expect(await entry()).toMatchObject({ name: 'new-api', status: 'ready' })
    })

    test('whose deploy failed and was then reverted brings back the old name and trust key, ready, with the reason', async () => {
      await seed([changing()])

      await projectOperation(db, operationAt('deploy-failed', [CHANGE]))

      expect(await entry()).toMatchObject({ name: 'new-api', status: 'failed' })

      await projectOperation(
        db,
        operationAt('deploy-failed', [CHANGE], {
          stateVersion: 6,
          error: { code: 'operation-reverted', message: 'reverted' }
        })
      )

      expect(await entry()).toMatchObject({
        name: 'beta-api',
        service: 'beta-api',
        trustKey: 'CDP service beta-api',
        status: 'ready',
        failureReason: expect.stringContaining('reverted')
      })
    })

    test('whose deploy failed and was then reverted brings back an Azure application’s principal ID', async () => {
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

      await projectOperation(db, operationAt('deploy-failed', [CHANGE]))
      await projectOperation(
        db,
        operationAt('deploy-failed', [CHANGE], {
          stateVersion: 6,
          error: { code: 'operation-reverted', message: 'reverted' }
        })
      )

      expect(await entry()).toMatchObject({
        name: 'old-app',
        principalId: 'a',
        trustKey: 'issuer a',
        status: 'ready'
      })
    })

    test('whose deploy failed and recovered keeps the new definition', async () => {
      await seed([changing()])

      await projectOperation(db, operationAt('deploy-failed', [CHANGE]))
      await projectOperation(
        db,
        operationAt('active', [CHANGE], { stateVersion: 7 })
      )

      expect(await entry()).toMatchObject({ name: 'new-api', status: 'ready' })
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
    await seed([
      fresh({
        operationId: OLDER,
        operation: { id: OLDER },
        projectedGeneration: 1,
        projectedVersion: 9
      })
    ])

    await projectOperation(
      db,
      operationAt('requested', [{ ...CHANGE, generation: 2 }], {
        stateVersion: 0
      })
    )

    expect((await entry()).operationId).toBe(
      '0193a000-0000-7000-8000-0000000abcde'
    )
  })

  test('takes the operation of a later generation even when its id sorts below the id of the one before, and then holds it against that one redelivered', async () => {
    // Ids carry random suffixes and each host's clock: a later request can
    // have the smaller id.
    const first = '0193b000-0000-7000-8000-0000000000ff'
    const later = '0193a000-0000-7000-8000-000000000001'

    await seed([fresh()])

    await projectOperation(
      db,
      operationAt('active', [{ ...ADD, generation: 1 }], {
        _id: first,
        stateVersion: 6
      })
    )
    await projectOperation(
      db,
      operationAt('deploying', [{ ...REMOVE, generation: 2 }], {
        _id: later,
        stateVersion: 2
      })
    )

    expect(await entry()).toMatchObject({
      status: 'removing',
      operationId: later,
      projectedGeneration: 2,
      projectedVersion: 2
    })

    await projectOperation(
      db,
      operationAt('active', [{ ...ADD, generation: 1 }], {
        _id: first,
        stateVersion: 9
      })
    )

    expect(await entry()).toMatchObject({
      status: 'removing',
      operationId: later,
      projectedGeneration: 2
    })
  })

  test('still orders the writes of one generation by state version', async () => {
    await seed([fresh({ projectedGeneration: 3, projectedVersion: 6 })])

    await projectOperation(
      db,
      operationAt('deploying', [{ ...ADD, generation: 3 }], { stateVersion: 4 })
    )

    expect((await entry()).projectedVersion).toBe(6)
  })

  describe('an event of an earlier operation, redelivered after a newer one took the application', () => {
    test('does not mark a removed application ready again', async () => {
      await seed([
        fresh({
          status: 'removed',
          operationId: NEWER,
          operation: { id: NEWER, state: 'active' },
          projectedGeneration: 2,
          projectedVersion: 3
        })
      ])

      await projectOperation(
        db,
        operationAt('active', [{ ...ADD, generation: 1 }], { stateVersion: 9 })
      )

      expect(await entry()).toMatchObject({
        status: 'removed',
        operationId: NEWER,
        projectedVersion: 3
      })
    })

    test('does not consume the pending definition of the newer change', async () => {
      const pending = {
        name: 'new-api',
        service: 'new-api',
        trustKey: 'CDP service new-api'
      }

      await seed([
        fresh({
          trustKey: 'CDP service beta-api',
          pending,
          operationId: NEWER,
          operation: { id: NEWER, state: 'deploying' },
          projectedGeneration: 2,
          projectedVersion: 3
        })
      ])

      await projectOperation(
        db,
        operationAt('active', [{ ...CHANGE, generation: 1 }], {
          stateVersion: 9
        })
      )

      expect(await entry()).toMatchObject({
        name: 'beta-api',
        status: 'setting-up',
        pending,
        operationId: NEWER
      })
    })
  })

  describe('an older change recovering after a newer one reserved the application, before the newer one was first projected', () => {
    const pending = {
      name: 'new-api',
      service: 'new-api',
      trustKey: 'CDP service new-api'
    }
    // The entry as the newer change's reservation left it: generation 2 taken
    // and its definition pending, the older change (generation 1) the last
    // to have projected, from a timeout before its commit.
    const reserved = (extra = {}) =>
      fresh({
        trustKey: 'CDP service beta-api',
        pending,
        statusBefore: 'ready',
        status: 'setting-up',
        generation: 2,
        projectedGeneration: 1,
        projectedVersion: 4,
        operationId: OLDER,
        operation: { id: OLDER, state: 'timed-out' },
        ...extra
      })

    test.each(['active', 'deploy-failed', 'timed-out'])(
      'is not projected over the reservation when it is %s',
      async (state) => {
        await seed([reserved()])

        await projectOperation(
          db,
          operationAt(state, [{ ...CHANGE, generation: 1 }], {
            stateVersion: 9,
            gitops: { commitSha: 'abc123' }
          })
        )

        expect(await entry()).toMatchObject({
          name: 'beta-api',
          service: 'beta-api',
          status: 'setting-up',
          pending,
          statusBefore: 'ready',
          operationId: OLDER,
          projectedVersion: 4
        })
      }
    )

    test('leaves the newer change to be projected when it is first taken', async () => {
      await seed([reserved()])

      await projectOperation(
        db,
        operationAt('active', [{ ...CHANGE, generation: 1 }], {
          stateVersion: 9
        })
      )
      await projectOperation(
        db,
        operationAt('requested', [{ ...CHANGE, generation: 2 }], {
          _id: NEWER,
          stateVersion: 1
        })
      )

      expect(await entry()).toMatchObject({
        status: 'setting-up',
        pending,
        operationId: NEWER,
        projectedGeneration: 2
      })
    })

    test('still takes the operation of the generation the entry holds', async () => {
      await seed([reserved({ operationId: NEWER })])

      await projectOperation(
        db,
        operationAt('active', [{ ...CHANGE, generation: 2 }], {
          _id: NEWER,
          stateVersion: 1
        })
      )

      expect(await entry()).toMatchObject({
        name: 'new-api',
        status: 'ready',
        pending: null,
        projectedGeneration: 2
      })
    })
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
