/**
 * Port for reading the GitOps state files as Git holds them, read-only.
 *
 * @typedef {object} TeamFileReader
 * @property {(params: {path: string}) => Promise<{document: object|null, sha: string|null}>} getCurrentDocument - the file on `main` now with its git blob SHA (the pin file's `expectedBase` is that blob SHA); both null when there is no file
 * @property {(params: {path: string, commitSha: string}) => Promise<{document: object|null}>} getPreviousDocument - the file as it was before the commit (its first parent), null when it did not exist
 */

export {}
