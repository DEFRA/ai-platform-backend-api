const RUN_URL = /^(https:\/\/\S+\/actions\/runs\/(\d+))/
const MAX_REMEMBERED = 500
// GitHub's maximum page size for listing Deployments.
const DEPLOYMENTS_PER_PAGE = 100

/**
 * Sets a cache entry, forgetting the oldest once more than 500 are held.
 * @param {Map} map
 * @param {string} key
 * @param {unknown} value
 */
export function remember(map, key, value) {
  map.set(key, value)

  if (map.size > MAX_REMEMBERED) {
    map.delete(map.keys().next().value)
  }
}

// The apply job's Deployment status links to its run; that run uploaded
// the run report.
function runOf(deploymentStatus) {
  const match = RUN_URL.exec(
    deploymentStatus?.log_url || deploymentStatus?.target_url || ''
  )

  return match ? { url: match[1], id: Number(match[2]) } : null
}

async function includesCommit(reads, mergeSha, sha) {
  if (sha === mergeSha) {
    return true
  }

  const { reader, client, repo, ancestry } = reads
  const key = `${repo.repo}:${mergeSha}...${sha}`

  if (!ancestry.has(key)) {
    const { status } = await reader.read(
      client,
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      { ...repo, basehead: `${mergeSha}...${sha}`, per_page: 1 }
    )

    remember(ancestry, key, ['ahead', 'identical'].includes(status))
  }

  return ancestry.get(key)
}

function createdBeforeMerge(deployment, merge) {
  return Date.parse(deployment.created_at) < Date.parse(merge.mergedAt)
}

// The Deployments on one page at the merge commit or a descendant of it,
// with their latest status and the run behind it.
async function observePage(reads, deployments, merge) {
  const { reader, client, repo } = reads
  const observed = []

  for (const deployment of deployments) {
    if (createdBeforeMerge(deployment, merge)) {
      continue
    }

    if (await includesCommit(reads, merge.mergeSha, deployment.sha)) {
      const [latest] = await reader.read(
        client,
        'GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses',
        { ...repo, deployment_id: deployment.id, per_page: 1 }
      )

      observed.push({ latest, run: runOf(latest) })
    }
  }

  return observed
}

/**
 * The Deployments at the merge commit or a descendant of it, newest first,
 * a page at a time until a page is the last or reaches a Deployment created
 * before the merge: that one, and every older one, cannot be at the merge
 * commit or a descendant of it. So an operation polled late still finds its
 * own apply behind later ones.
 * @param {object} reads - The repository's reader, client, repo and ancestry cache.
 * @param {string} environment
 * @param {{mergeSha: string, mergedAt: string}} merge
 * @returns {Promise<Array<{latest: object, run: {url: string, id: number} | null}>>}
 */
export async function deploymentsAtOrAfter(reads, environment, merge) {
  const { reader, client, repo } = reads
  const observed = []
  let page = 0
  let morePages = true

  while (morePages) {
    page += 1

    const deployments = await reader.read(
      client,
      'GET /repos/{owner}/{repo}/deployments',
      { ...repo, environment, per_page: DEPLOYMENTS_PER_PAGE, page }
    )

    observed.push(...(await observePage(reads, deployments, merge)))
    morePages =
      deployments.length === DEPLOYMENTS_PER_PAGE &&
      !deployments.some((deployment) => createdBeforeMerge(deployment, merge))
  }

  return observed
}
