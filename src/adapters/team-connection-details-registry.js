import { credentialIssuerRegistry } from '#/adapters/credential-issuer-registry.js'
import { createFixtureConnectionDetails } from '#/adapters/team-connection-details-fixture.js'

/**
 * The connection details of a team's environment, or null when there are
 * none to give. While the team's credentials are mocked (`isMockedFor('team')`)
 * the fixture adapter answers, flagged `placeholder`; there is no real adapter
 * until Entra is switched on (HVE item #87), so otherwise there are none and
 * a page shows nothing rather than invent them.
 * @param {{team: {slug: string}, environment: string}} params
 * @param {{issuers?: {isMockedFor: (tier: string) => boolean}, fixture?: import('./team-connection-details.js').TeamConnectionDetails}} [deps]
 * @returns {Promise<import('./team-connection-details.js').ConnectionDetails|null>}
 */
export async function connectionDetailsOf(
  params,
  {
    issuers = credentialIssuerRegistry,
    fixture = createFixtureConnectionDetails()
  } = {}
) {
  return issuers.isMockedFor('team') ? fixture.detailsFor(params) : null
}
