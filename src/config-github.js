/**
 * The `github` section of the convict schema: the credentials the backend
 * uses to read the catalogue and the state repositories. It lives apart from
 * `config.js` to keep that file short.
 */
export const githubConfigSchema = {
  token: {
    doc: 'Fine-grained GitHub PAT with Contents:Read on the catalogue repo (or use the App credentials below)',
    format: String,
    nullable: true,
    default: null,
    sensitive: true,
    env: 'GITHUB_TOKEN'
  },
  appId: {
    doc: 'GitHub App ID, an alternative to github.token - superseded by github.clientId if both are set',
    format: String,
    nullable: true,
    default: null,
    env: 'GITHUB_APP_ID'
  },
  clientId: {
    doc: 'GitHub App Client ID, preferred over github.appId per GitHub current guidance',
    format: String,
    nullable: true,
    default: null,
    env: 'GITHUB_CLIENT_ID'
  },
  installationId: {
    doc: 'GitHub App installation ID, required alongside github.appId',
    format: String,
    nullable: true,
    default: null,
    env: 'GITHUB_APP_INSTALLATION_ID'
  },
  privateKey: {
    doc: 'GitHub App private key, base64-encoded (required alongside github.appId)',
    format: String,
    nullable: true,
    default: null,
    sensitive: true,
    env: 'GITHUB_APP_PRIVATE_KEY'
  }
}
