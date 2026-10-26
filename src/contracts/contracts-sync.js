import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// The message contract (`aip.gitops.command/1`, `aip.gitops.event/1`) has one
// source, `ai-platform-infra/schemas/messages/`. It is vendored here byte for
// byte at the ref in `VERSION`; `contracts:check` fails on any difference, so
// the copy can never drift (plan 5, DD12).

const SOURCE =
  'https://raw.githubusercontent.com/DEFRA/ai-platform-infra/{ref}/schemas/messages/{file}'

/**
 * The schema files vendored from `ai-platform-infra`.
 */
export const CONTRACT_FILES = ['command.schema.json', 'event.schema.json']

/**
 * Where the vendored files and their `VERSION` live.
 */
export const CONTRACT_DIR = fileURLToPath(
  new URL('./aip-gitops/', import.meta.url)
)

const VERSION_FILE = 'VERSION'

/**
 * The raw URL of one schema file at a ref (a tag, branch or commit SHA).
 * @param {string} ref
 * @param {string} file
 * @returns {string}
 */
export function contractUrl(ref, file) {
  return SOURCE.replace('{ref}', ref).replace('{file}', file)
}

/**
 * The ref the vendored files were synced from.
 * @param {string} [dir]
 * @returns {Promise<string>}
 */
export async function readVersion(dir = CONTRACT_DIR) {
  const text = await readFile(`${dir}${VERSION_FILE}`, 'utf8')

  return text.trim()
}

// Downloads every contract file at the ref, failing on any non-200 so a typo
// in the ref can never write an error page over a schema.
async function downloadContracts(ref, fetchFn) {
  return Promise.all(
    CONTRACT_FILES.map(async (file) => {
      const response = await fetchFn(contractUrl(ref, file))

      if (!response.ok) {
        throw new Error(`${file} at ${ref}: GitHub answered ${response.status}`)
      }

      return [file, Buffer.from(await response.arrayBuffer())]
    })
  )
}

/**
 * Downloads both schemas at `ref` into the vendored directory and records
 * the ref in `VERSION`.
 * @param {{ref: string, dir?: string, fetchFn?: typeof fetch}} params
 * @returns {Promise<string[]>} The files written.
 */
export async function syncContracts({
  ref,
  dir = CONTRACT_DIR,
  fetchFn = fetch
}) {
  if (!ref) {
    throw new Error('Usage: npm run contracts:sync -- {ref}')
  }

  const downloaded = await downloadContracts(ref, fetchFn)

  await mkdir(dir, { recursive: true })

  await Promise.all(
    downloaded.map(([file, bytes]) => writeFile(`${dir}${file}`, bytes))
  )

  await writeFile(`${dir}${VERSION_FILE}`, `${ref}\n`)

  return downloaded.map(([file]) => file)
}

/**
 * Compares the vendored files with the ones at the ref in `VERSION`, byte for
 * byte.
 * @param {{dir?: string, fetchFn?: typeof fetch}} [params]
 * @returns {Promise<{ref: string, differing: string[]}>} The files that differ; none when in sync.
 */
export async function checkContracts({
  dir = CONTRACT_DIR,
  fetchFn = fetch
} = {}) {
  const ref = await readVersion(dir)
  const downloaded = await downloadContracts(ref, fetchFn)
  const vendored = await Promise.all(
    downloaded.map(([file]) => readFile(`${dir}${file}`).catch(() => null))
  )
  const differing = downloaded
    .filter(([, expected], index) => !vendored[index]?.equals(expected))
    .map(([file]) => file)

  return { ref, differing }
}
