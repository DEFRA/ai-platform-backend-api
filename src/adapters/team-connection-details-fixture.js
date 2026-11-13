import { createHash } from 'node:crypto'

import { config } from '#/config.js'

// The values come from nowhere real: the team's registration is not made in
// Entra while the credential issuer is mocked (until admin consent and HVE
// item #87), so they are flagged as a placeholder and a page says so.

const FIXTURE_GATEWAY = 'https://mock-gateway.ai-platform.example'
const FIXTURE_TENANT = '00000000-0000-4000-8000-000000000000'
const CDP_AUDIENCE = 'api://AzureADTokenExchange'
const UUID_GROUPS = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
  .split('-')
  .map((group) => group.length)

// A repeatable GUID for a team and environment, so the page does not change
// on every read.
function guidFor(text) {
  const hex = createHash('sha256').update(text).digest('hex')
  let offset = 0

  return UUID_GROUPS.map((length) => {
    const group = hex.slice(offset, offset + length)

    offset += length

    return group
  }).join('-')
}

/**
 * The fixture adapter of the `TeamConnectionDetails` port: made-up, repeatable
 * values, always flagged `placeholder`.
 * @returns {import('./team-connection-details.js').TeamConnectionDetails}
 */
export function createFixtureConnectionDetails() {
  return {
    async detailsFor({ team, environment }) {
      const tenantId = config.get('portalAuth.tenantId') ?? FIXTURE_TENANT
      const clientId = guidFor(`${team.slug}:${environment}`)

      return {
        placeholder: true,
        gatewayUrl: `${FIXTURE_GATEWAY}/${team.slug}`,
        tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        clientId,
        tenantId,
        scope: `api://${clientId}/.default`,
        cdpAudience: CDP_AUDIENCE
      }
    }
  }
}
