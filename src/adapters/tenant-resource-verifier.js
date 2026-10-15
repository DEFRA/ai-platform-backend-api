/**
 * Port for confirming, after a successful apply, that the resources the run
 * report says a team now has really exist in Azure - the GitOps contract's
 * `deployed -> verified` step. Implementations never create or change
 * anything.
 * @typedef {object} TenantResourceVerifier
 * @property {(params: {environment: string, resources: object|null}) => Promise<{verified: boolean, reason?: string}>} verify
 *   `resources` is the team's entry in the run report's `outputs.teams.value`; `reason` is a stable code when not verified
 */

export {}
