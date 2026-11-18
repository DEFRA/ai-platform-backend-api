import { ObjectId } from 'mongodb'

import { forEachSequentially } from '#/common/helpers/sequential.js'
import { UNTIL_REVOKED } from '#/adapters/access-window-format.js'
import { accessWindowStore } from '#/adapters/access-window-store-registry.js'
import { servicePrincipalSwitch } from '#/adapters/service-principal-switch-registry.js'
import { connectionDetailsOf } from '#/adapters/team-connection-details-registry.js'

// What Disable and Enable credentials do to a team's registration in one
// environment, beyond the `adminBlocked` flag (R-D1, R-D3, design F): the
// client's entry in the team's access window at the gateway, and the
// registration's service principal in Entra. Every step is idempotent, so a
// retry repeats them. The caller holds the block lock and orders the flag
// around them: Disable sets it first, Enable clears it last.

const DEPLOYMENTS = 'teamDeployments'
const SECONDS_ONLY = /\.\d{3}Z$/

// The ordinary window is none until B18 activates one; B18 supplies this.
async function noOrdinaryEntry() {
  return null
}

function sameClient(a, b) {
  return a.toLowerCase() === b.toLowerCase()
}

function inSeconds(time) {
  return time.toISOString().replace(SECONDS_ONLY, 'Z')
}

// Whether the ordinary entry lets the client in at `at`.
function allows(entry, at) {
  return (
    entry?.status === 'active' &&
    new Date(entry.validFrom) <= at &&
    (entry.expiresAt === UNTIL_REVOKED || at < new Date(entry.expiresAt))
  )
}

function unknownClient() {
  const error = new Error("The registration's client ID is not known")
  error.code = 'registration-client-unknown'
  return error
}

async function targetOf(db, { teamId, environment }) {
  const [doc, team] = await Promise.all([
    db
      .collection(DEPLOYMENTS)
      .findOne(
        { teamId, environment },
        { projection: { 'oauthClient.registration': 1 } }
      ),
    ObjectId.isValid(teamId)
      ? db
          .collection('teams')
          .findOne({ _id: new ObjectId(teamId) }, { projection: { slug: 1 } })
      : null
  ])

  return {
    registration: doc?.oauthClient?.registration ?? null,
    teamSlug: team?.slug
  }
}

async function clientIdOf({ registration, teamSlug, environment }, connection) {
  return (
    registration?.clientId ??
    (await connection({ team: { slug: teamSlug }, environment }))?.clientId ??
    null
  )
}

// The entry the window holds for the client: suspended while blocked, else the
// ordinary one (none removes it).
function entryFor({ blocked, clientId, ordinary, current, at }) {
  if (!blocked) {
    return ordinary
  }

  const base =
    ordinary ??
    (current?.status === 'suspended'
      ? current
      : { validFrom: inSeconds(at), expiresAt: UNTIL_REVOKED })

  return { ...base, clientId, status: 'suspended' }
}

async function writeWindow(
  { environment, teamSlug, clientId, ordinary, blocked, at },
  store
) {
  if (!clientId) {
    return
  }

  const entries = await store.read({ environment, teamSlug })
  const current = entries.find((each) => sameClient(each.clientId, clientId))
  const entry = entryFor({ blocked, clientId, ordinary, current, at })
  const others = entries.filter((each) => each !== current)

  await store.write({
    environment,
    teamSlug,
    entries: entry ? [...others, entry] : others
  })
}

// Enable switches the principal on only where the ordinary window allows it.
async function switchPrincipal(
  { db, teamId, environment, registration, ordinary, blocked, at, now },
  servicePrincipal
) {
  const objectId = registration?.servicePrincipalObjectId

  if (!objectId || (!blocked && !allows(ordinary, at))) {
    return
  }

  await servicePrincipal.setAccountEnabled({
    environment,
    objectId,
    enabled: !blocked
  })

  if (blocked) {
    await db
      .collection(DEPLOYMENTS)
      .updateOne(
        { teamId, environment },
        { $set: { servicePrincipalDisabledAt: now().toISOString() } }
      )
  }
}

/**
 * Called after a Platform Admin's Disable, Enable or Revoke of one secret. A
 * revoke has no registration-wide effect. Disable writes the window `suspended`,
 * then switches the service principal off and keeps the time that was
 * confirmed on the `teamDeployments` record; Enable switches the principal on
 * (where the ordinary window allows), then restores the ordinary window. A
 * failed step rejects, so the caller keeps the block. A registration with no
 * service principal object ID has no switch made; a team with no registration
 * and no client ID has no window to write.
 * @param {import('mongodb').Db} db
 * @param {{teamId: string, environment: string, change: 'disabled'|'enabled'|'revoked'}} change
 * @param {{store?: import('#/adapters/access-window-store.js').AccessWindowStore, servicePrincipal?: import('#/adapters/service-principal-switch.js').ServicePrincipalSwitch, ordinaryEntry?: (params: {environment: string, teamSlug: string, clientId: string}) => Promise<import('#/adapters/access-window-format.js').AccessWindowEntry|null>, connection?: typeof connectionDetailsOf, now?: () => Date}} [deps]
 * @returns {Promise<void>}
 */
export async function credentialsAccessChanged(
  db,
  { teamId, environment, change },
  {
    store = accessWindowStore,
    servicePrincipal = servicePrincipalSwitch,
    ordinaryEntry = noOrdinaryEntry,
    connection = connectionDetailsOf,
    now = () => new Date()
  } = {}
) {
  if (change === 'revoked') {
    return
  }

  const blocked = change === 'disabled'
  const { registration, teamSlug } = await targetOf(db, { teamId, environment })
  const clientId = await clientIdOf(
    { registration, teamSlug, environment },
    connection
  )

  if (registration && !clientId) {
    throw unknownClient()
  }

  const at = now()
  const ordinary = clientId
    ? await ordinaryEntry({ environment, teamSlug, clientId })
    : null
  const window = () =>
    writeWindow(
      { environment, teamSlug, clientId, ordinary, blocked, at },
      store
    )
  const principal = () =>
    switchPrincipal(
      { db, teamId, environment, registration, ordinary, blocked, at, now },
      servicePrincipal
    )

  await forEachSequentially(
    blocked ? [window, principal] : [principal, window],
    (step) => step()
  )
}
