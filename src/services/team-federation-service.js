// Federating an application to a team's registration in each environment
// (design E): one operation per environment on that environment's team file,
// the application recorded in the team's document from the moment it is asked
// for, and followed through the operation's states. Every action and every
// refusal is audited; another team is never named. The requests are in
// team-federation-request.js, -change.js and -remove.js.

export {
  checkFederation,
  requestFederations
} from '#/services/team-federation-request.js'
export { changeFederation } from '#/services/team-federation-change.js'
export { removeFederation } from '#/services/team-federation-remove.js'
