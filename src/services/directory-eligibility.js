const GUEST_MARKER = '#ext#'

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

  if (person.mail === undefined || person.mail === null || person.mail === '') {
    return true
  }

  const mailDomain = domainOf(person.mail)

  return mailDomain !== null && domains.has(mailDomain)
}
