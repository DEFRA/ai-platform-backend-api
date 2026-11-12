/**
 * Port for what a team's application needs to call its models in one
 * environment: where the gateway is, where to ask for a token and which
 * registration to ask as. Read-only.
 *
 * @typedef {object} ConnectionDetails
 * @property {boolean} placeholder - true while the values are made up (Entra is mocked), so a page says so
 * @property {string} gatewayUrl - the team's API on the gateway; the first call is `GET {gatewayUrl}/whoami`
 * @property {string} tokenEndpoint - the Entra v2 token endpoint of the Defra tenant
 * @property {string} clientId - the client ID of the team's registration in the environment
 * @property {string} tenantId - the Defra tenant
 * @property {string} scope - the scope a token request asks for
 * @property {string} cdpAudience - the audience a CDP service's federated token carries
 *
 * @typedef {object} TeamConnectionDetails
 * @property {(params: {team: {slug: string}, environment: string}) => Promise<ConnectionDetails>} detailsFor
 */

export {}
