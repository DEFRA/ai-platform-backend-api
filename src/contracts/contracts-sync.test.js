import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONTRACT_DIR,
  CONTRACT_FILES,
  checkContracts,
  contractUrl,
  readVersion,
  syncContracts
} from '#/contracts/contracts-sync.js'

function fetchOf(files, status = 200) {
  const requested = []
  const fetchFn = async (url) => {
    requested.push(url)
    const body = files[url.split('/').at(-1)] ?? ''

    return {
      ok: status === 200,
      status,
      arrayBuffer: async () => Buffer.from(body)
    }
  }

  return { fetchFn, requested }
}

const UPSTREAM = {
  'command.schema.json': '{"title":"command"}\n',
  'event.schema.json': '{"title":"event"}\n'
}

describe('#contracts-sync', () => {
  let dir

  beforeEach(async () => {
    dir = `${await mkdtemp(join(tmpdir(), 'contracts-'))}/`
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('reads each schema from the infra repository at the ref', () => {
    expect(contractUrl('v0.10.0', 'event.schema.json')).toBe(
      'https://raw.githubusercontent.com/DEFRA/ai-platform-infra/v0.10.0/schemas/messages/event.schema.json'
    )
  })

  test('sync writes both files byte for byte and records the ref', async () => {
    const { fetchFn, requested } = fetchOf(UPSTREAM)

    const written = await syncContracts({ ref: 'abc123', dir, fetchFn })

    expect(written).toEqual(CONTRACT_FILES)
    expect(requested).toHaveLength(2)
    expect(await readFile(`${dir}command.schema.json`, 'utf8')).toBe(
      UPSTREAM['command.schema.json']
    )
    expect(await readVersion(dir)).toBe('abc123')
  })

  test('sync refuses a missing ref', async () => {
    await expect(
      syncContracts({ dir, fetchFn: fetchOf({}).fetchFn })
    ).rejects.toThrow(/contracts:sync/)
  })

  test('sync writes nothing when GitHub does not have the ref', async () => {
    const { fetchFn } = fetchOf(UPSTREAM, 404)

    await expect(syncContracts({ ref: 'nope', dir, fetchFn })).rejects.toThrow(
      /GitHub answered 404/
    )
    await expect(readFile(`${dir}VERSION`)).rejects.toThrow()
  })

  test('check passes when the copy is identical', async () => {
    const { fetchFn } = fetchOf(UPSTREAM)

    await syncContracts({ ref: 'abc123', dir, fetchFn })

    expect(await checkContracts({ dir, fetchFn })).toEqual({
      ref: 'abc123',
      differing: []
    })
  })

  test('check fails on any difference, even one byte, or a missing file', async () => {
    const { fetchFn } = fetchOf(UPSTREAM)

    await syncContracts({ ref: 'abc123', dir, fetchFn })
    await writeFile(`${dir}event.schema.json`, '{"title":"event"} \n')
    await rm(`${dir}command.schema.json`)

    expect(await checkContracts({ dir, fetchFn })).toEqual({
      ref: 'abc123',
      differing: ['command.schema.json', 'event.schema.json']
    })
  })

  test('the vendored directory holds the schemas and the ref they came from', async () => {
    expect(await readVersion(CONTRACT_DIR)).toMatch(/\S/)

    for (const file of CONTRACT_FILES) {
      expect(
        JSON.parse(await readFile(`${CONTRACT_DIR}${file}`, 'utf8')).$id
      ).toBe(file)
    }
  })
})
