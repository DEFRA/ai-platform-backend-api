import { MongoClient } from 'mongodb'

import {
  attachMockTeamFileDatabase,
  createMockTeamFileReader,
  mockTeamFileReader
} from '#/adapters/mock-team-file-reader.js'
import { describeTeamFileReaderContract } from '#/adapters/team-file-reader-contract.js'
import { uuidv7 } from '#/common/helpers/uuid-v7.js'

const DATABASE = 'mock-team-file-reader-test'
const PATH = 'environments/infradev/alpha.json'

describeTeamFileReaderContract('mock', () => mockTeamFileReader)

describe('#mockTeamFileReader with a database', () => {
  let client
  let db
  let reader
  let clock = Date.parse('2026-11-12T10:00:00.000Z')

  // An operation as the operations hold it: the document is canonical JSON,
  // and each is created, and committed, a minute after the last. `gitops`
  // overrides its commit facts.
  function operation(overrides = {}) {
    const { document = { revision: 1 }, gitops, ...rest } = overrides
    const createdAt = nextMinute()

    return {
      _id: uuidv7(),
      type: 'team-file.write',
      state: 'committed',
      target: { path: PATH },
      document: JSON.stringify(document),
      gitops: { commitSha: 'a'.repeat(40), committedAt: createdAt, ...gitops },
      createdAt,
      ...rest
    }
  }

  function nextMinute() {
    clock += 60000

    return new Date(clock).toISOString()
  }

  async function arrange(...operations) {
    await db.collection('operations').deleteMany({})

    if (operations.length > 0) {
      await db.collection('operations').insertMany(operations)
    }
  }

  beforeAll(async () => {
    client = await MongoClient.connect(process.env.MONGO_URI)
    db = client.db(DATABASE)
    reader = createMockTeamFileReader({ getDatabase: () => db })
  })

  afterAll(async () => {
    await client.db(DATABASE).dropDatabase()
    await client.close()
  })

  describeTeamFileReaderContract(
    'mock with a database holding no operations',
    () => reader
  )

  test('serves the document of the newest operation that reached committed, with its commit sha', async () => {
    await arrange(
      operation({ _id: uuidv7(), document: { revision: 1 } }),
      operation({
        _id: uuidv7(),
        state: 'active',
        document: { revision: 2 },
        gitops: { commitSha: 'b'.repeat(40) }
      })
    )

    await expect(reader.getCurrentDocument({ path: PATH })).resolves.toEqual({
      document: { revision: 2 },
      sha: 'b'.repeat(40)
    })
  })

  test.each([
    'committed',
    'deploying',
    'deployed',
    'verified',
    'active',
    'removed',
    'deploy-failed'
  ])('serves a document whose operation is %s', async (state) => {
    await arrange(operation({ state }))

    const { document } = await reader.getCurrentDocument({ path: PATH })

    expect(document).toEqual({ revision: 1 })
  })

  test('does not serve the document of a change that failed its checks, so the earlier one stays', async () => {
    await arrange(
      operation({ _id: uuidv7(), document: { revision: 1 } }),
      operation({
        _id: uuidv7(),
        state: 'checks-failed',
        document: { revision: 2 }
      })
    )

    const { document } = await reader.getCurrentDocument({ path: PATH })

    expect(document).toEqual({ revision: 1 })
  })

  test.each(['queued', 'requested'])(
    'does not serve the document of an operation still %s: nothing has reached main',
    async (state) => {
      await arrange(operation({ state }))

      await expect(reader.getCurrentDocument({ path: PATH })).resolves.toEqual({
        document: null,
        sha: null
      })
    }
  )

  test('serves a timed-out operation only when it had reached committed', async () => {
    await arrange(operation({ state: 'timed-out', leftState: 'deploying' }))

    expect((await reader.getCurrentDocument({ path: PATH })).document).toEqual({
      revision: 1
    })

    await arrange(operation({ state: 'timed-out', leftState: 'requested' }))

    expect(
      (await reader.getCurrentDocument({ path: PATH })).document
    ).toBeNull()
  })

  test('serves nothing for another path, and uses the placeholder sha when no commit is recorded', async () => {
    await arrange(operation({ gitops: { commitSha: undefined } }))

    await expect(
      reader.getCurrentDocument({ path: 'environments/infradev/beta.json' })
    ).resolves.toEqual({ document: null, sha: null })

    const { sha } = await reader.getCurrentDocument({ path: PATH })

    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('serves the change that committed last, even when an older operation committed after a newer one (a retry)', async () => {
    const older = operation({ document: { revision: 1, change: 'older' } })
    const newer = operation({ document: { revision: 2, change: 'newer' } })

    // The older operation timed out, and its retry committed after the newer
    // operation finished.
    older.gitops.committedAt = nextMinute()

    await arrange(older, newer)

    const { document } = await reader.getCurrentDocument({ path: PATH })

    expect(document).toEqual({ revision: 1, change: 'older' })
  })

  test('serves a missing file once a committed deletion is the newest change, as a revert of a new file leaves it', async () => {
    const created = operation({
      state: 'deploy-failed',
      document: { revision: 1 }
    })
    const reverted = operation({ action: 'remove' })

    delete reverted.document

    await arrange(created, reverted)

    await expect(reader.getCurrentDocument({ path: PATH })).resolves.toEqual({
      document: null,
      sha: null
    })
  })

  describe('the file before a commit, for a revert', () => {
    const FIRST_SHA = '1'.repeat(40)
    const SECOND_SHA = '2'.repeat(40)

    function twoChanges() {
      return [
        operation({
          state: 'active',
          document: { revision: 1, models: ['a'], limits: 1000 },
          gitops: { commitSha: FIRST_SHA }
        }),
        operation({
          state: 'deploy-failed',
          document: { revision: 2, models: ['a', 'b'], limits: 2000 },
          gitops: { commitSha: SECOND_SHA }
        })
      ]
    }

    test('is the file as the change before it left it, with its models and limits', async () => {
      await arrange(...twoChanges())

      await expect(
        reader.getPreviousDocument({ path: PATH, commitSha: SECOND_SHA })
      ).resolves.toEqual({
        document: { revision: 1, models: ['a'], limits: 1000 }
      })
    })

    test('is null when the commit made the file, so a revert removes it', async () => {
      await arrange(...twoChanges())

      await expect(
        reader.getPreviousDocument({ path: PATH, commitSha: FIRST_SHA })
      ).resolves.toEqual({ document: null })
    })

    test('is null when the file before the commit had been deleted, or the commit is not known', async () => {
      const [first, second] = twoChanges()
      const removal = operation({ state: 'active', action: 'remove' })
      const third = operation({
        document: { revision: 1 },
        gitops: { commitSha: '3'.repeat(40) }
      })

      delete removal.document

      await arrange(first, second, removal, third)

      await expect(
        reader.getPreviousDocument({ path: PATH, commitSha: '3'.repeat(40) })
      ).resolves.toEqual({ document: null })
      await expect(
        reader.getPreviousDocument({ path: PATH, commitSha: 'f'.repeat(40) })
      ).resolves.toEqual({ document: null })
    })

    test('is null with no database', async () => {
      await expect(
        createMockTeamFileReader({
          getDatabase: () => null
        }).getPreviousDocument({ path: PATH, commitSha: SECOND_SHA })
      ).resolves.toEqual({ document: null })
    })
  })

  test('still serves the research file before any operation', async () => {
    await arrange(
      operation({ target: { path: 'environments/sandbox/research.json' } })
    )

    const { document } = await reader.getCurrentDocument({
      path: 'environments/sandbox/research.json'
    })

    expect(document.environment).toBe('sandbox')
  })

  test('the shared reader reads the database the mock transport attached, and nothing before one is', async () => {
    await arrange(operation())

    attachMockTeamFileDatabase(null)

    await expect(
      mockTeamFileReader.getCurrentDocument({ path: PATH })
    ).resolves.toEqual({ document: null, sha: null })

    attachMockTeamFileDatabase(db)

    try {
      const { document } = await mockTeamFileReader.getCurrentDocument({
        path: PATH
      })

      expect(document).toEqual({ revision: 1 })
    } finally {
      attachMockTeamFileDatabase(null)
    }
  })
})

describe('#mockTeamFileReader', () => {
  test('serves the research file for any environment with a placeholder sha', async () => {
    const current = await mockTeamFileReader.getCurrentDocument({
      path: 'environments/sandbox/research.json'
    })

    expect(current.document.environment).toBe('sandbox')
    expect(current.document.deployments).toEqual(expect.any(Array))
    expect(current.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('returns a fresh document on every read', async () => {
    const path = 'environments/infradev/research.json'
    const first = await mockTeamFileReader.getCurrentDocument({ path })

    first.document.environment = 'changed'

    const second = await mockTeamFileReader.getCurrentDocument({ path })

    expect(second.document.environment).toBe('infradev')
  })

  test.each(['environments/infradev/alpha.json', undefined])(
    'returns nulls for %s',
    async (path) => {
      await expect(
        mockTeamFileReader.getCurrentDocument(path ? { path } : undefined)
      ).resolves.toEqual({ document: null, sha: null })
    }
  )
})
