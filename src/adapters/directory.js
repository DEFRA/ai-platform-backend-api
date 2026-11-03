/**
 * Port for finding people in the organisation's directory, so a team Admin can
 * add a colleague who has not signed in yet (design F, `#membership`). The
 * mock holds fictional seeded people; the Graph adapter reads Entra ID on
 * behalf of the signed-in Admin. A failed lookup rejects with
 * `503 directory-unavailable`; a person who is not there is `null`.
 *
 * @typedef {object} DirectoryPerson
 * @property {string} oid - the person's Entra object ID, the key people are held by
 * @property {string} displayName
 * @property {string|null} mail
 * @property {string} userPrincipalName
 *
 * @typedef {object} Directory
 * @property {(params: {userAssertion?: string, query: string}) => Promise<DirectoryPerson[]>} searchPeople - people whose name has a word starting each word of the query, or whose mail starts with it; unfiltered for eligibility
 * @property {(params: {userAssertion?: string, oid: string}) => Promise<DirectoryPerson|null>} getPerson - one person by object ID, `null` when the directory has none
 */

export {}
