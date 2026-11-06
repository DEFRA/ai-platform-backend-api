// The credential service's public surface. The work lives in cohesive modules:
//   credential-common.js         constants, environment and lock helpers
//   credential-vault-writer.js   writing a secret to the vault
//   credential-issuance.js       issuing and activating a credential row
//   research-credential-issue.js a person's research key
//   team-credential-ensure.js    a team's shared credential
//   credential-presenter.js      how a credential leaves the service
//   credential-access.js         listing, finding and authorising
//   credential-lifecycle.js      renew, rotate, revoke and reveal
export {
  credentialLockName,
  environmentOf,
  externalGatewaySubscriptionIdOf
} from '#/services/credential-common.js'
export { writeSecretToVault } from '#/services/credential-vault-writer.js'
export { issueCredential } from '#/services/research-credential-issue.js'
export {
  ensureTeamCredential,
  teamCredentialNeedsRetry
} from '#/services/team-credential-ensure.js'
export {
  findCredentialForUser,
  findCredentialForViewing,
  listCredentials
} from '#/services/credential-access.js'
export {
  renewCredential,
  revealCredential,
  revokeCredential,
  rotateCredential
} from '#/services/credential-lifecycle.js'
