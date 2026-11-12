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
  // and each is created a minute after the last.
  function operation(overrides = {}) {
    const { document = { revision: 1 }, ...rest } = overrides

    clock += 60000

    return {
      _id: uuidv7(),
      type: 'team-file.write',
      state: 'committed',
      target: { path: PATH },
      document: JSON.stringify(document),
      gitops: { commitSha: 'a'.repeat(40) },
      createdAt: new Date(clock).toISOString(),
      ...rest
    }
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
    await arrange(operation({ gitops: {} }))

    await expect(
      reader.getCurrentDocument({ path: 'environments/infradev/beta.json' })
    ).resolves.toEqual({ document: null, sha: null })

    const { sha } = await reader.getCurrentDocument({ path: PATH })

    expect(sha).toMatch(/^[0-9a-f]{40}$/)
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
