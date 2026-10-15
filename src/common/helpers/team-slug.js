// A team's slug names its GitOps file, its gateway API path `/{slug}` and the
// deployments derived from it (`{slug}-{model}`), so it must match the
// `ai-platform-infra` team schema and never change once a team has one.
export const TEAM_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,22}[a-z0-9]$/

const MIN_LENGTH = 3
const MAX_LENGTH = 24
const FALLBACK_SLUG = 'team'

/**
 * Trims a candidate to the slug's maximum length and drops any trailing
 * hyphen, which the pattern does not allow.
 * @param {string} candidate
 * @returns {string}
 */
function trimToPattern(candidate) {
  return candidate.slice(0, MAX_LENGTH).replace(/-+$/, '')
}

/**
 * Derives a team's permanent slug from its display name: lower case, accents
 * folded, anything else hyphenated, starting at the first letter. Names that
 * leave nothing usable (digits or punctuation only) fall back to `team`, which
 * `createTeam` then makes unique with a numeric suffix.
 * @param {string} name
 * @returns {string}
 */
export function deriveTeamSlug(name) {
  const folded = (name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  const candidate = trimToPattern(
    folded.replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '')
  )

  return candidate.length >= MIN_LENGTH ? candidate : FALLBACK_SLUG
}

/**
 * Makes a numbered variant of a slug when the derived one is taken, keeping
 * the result within the pattern's length.
 * @param {string} slug
 * @param {number} attempt - the attempt number, 2 for the first retry
 * @returns {string}
 */
export function withSlugSuffix(slug, attempt) {
  const suffix = `-${attempt}`

  return `${trimToPattern(slug.slice(0, MAX_LENGTH - suffix.length))}${suffix}`
}
