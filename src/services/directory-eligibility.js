const GUEST_MARKER = '#ext#'

// The rule for who is eligible, by address. The frontend repeats it
// (ai-platform-frontend `src/server/common/helpers/eligibility-rule.js`) and
// both run the same test table: change one, change the other.

/**
 * The domain of an address that has exactly one `@` and a local part, lower
 * case; null for anything else (so a guest UPN such as
 * `name_example.com#EXT#@tenant.onmicrosoft.com` is judged by its whole shape,
 * not by the text after the last `@` alone).
 * @param {unknown} address
 * @returns {string|null}
 */
function domainOf(address) {
  if (typeof address !== 'string') {
    return null
  }

  const lower = address.trim().toLowerCase()
  const parts = lower.split('@')

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }

  return lower.includes(GUEST_MARKER) ? null : parts[1]
}

/**
 * The person's mail as an address, or null when they have none: a blank or
 * whitespace-only mail is no mail. Anything that is not text is returned as it
 * is, so it fails the domain check and is never mistaken for absent.
 * @param {{mail?: unknown}} person
 * @returns {unknown}
 */
function mailOf(person) {
  const { mail } = person

  return typeof mail === 'string' ? mail.trim() || null : (mail ?? null)
}

/**
 * The address to show and store for an eligible person: their mail, else their
 * user principal name. Never a blank.
 * @param {{userPrincipalName: string, mail?: unknown}} person
 * @returns {string}
 */
export function emailOf(person) {
  return mailOf(person) ?? person.userPrincipalName
}

/**
 * Whether a directory person may be added to a team: a member (not a guest)
 * of an allowed Defra tenant domain, by UPN and, when they have one, by mail.
 * The domain must match exactly, so a subdomain or look-alike is refused
 * (design F, DF:51).
 * @param {{userPrincipalName?: unknown, mail?: unknown}|null|undefined} person
 * @param {string[]} allowedDomains
 * @returns {boolean}
 */
export function isEligible(person, allowedDomains) {
  const domains = new Set(
    allowedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean)
  )
  const upnDomain = domainOf(person?.userPrincipalName)

  if (!upnDomain || !domains.has(upnDomain)) {
    return false
  }

  const mail = mailOf(person)

  if (mail === null) {
    return true
  }

  const mailDomain = domainOf(mail)

  return mailDomain !== null && domains.has(mailDomain)
}
