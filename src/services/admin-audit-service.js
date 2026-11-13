import { ObjectId } from 'mongodb'

import { config } from '#/config.js'
import {
  PLATFORM_ADMIN_ROLE,
  TEAM_ADMIN,
  requirePlatformAdmin
} from '#/common/helpers/auth/access.js'
import { SYSTEM_ROLE } from '#/common/helpers/auth/system-actor.js'
import { escapeRegex } from '#/common/helpers/escape-regex.js'

/** Events on a page of the Platform Admin Audit log (design F). */
export const AUDIT_PAGE_SIZE = 25

// The most people a Person filter considers: a name this common is too broad
// to be a useful filter, and the cap keeps the lookup bounded.
const MAX_PEOPLE_MATCHED = 100

const PERSON = 'person'

/**
 * The actor types of the Audit log's Actor type filter, in the order the
 * filter lists them (design F, D5).
 */
export const ACTOR_TYPES = Object.freeze([
  PLATFORM_ADMIN_ROLE,
  'team-admin',
  'team-member',
  PERSON,
  SYSTEM_ROLE
])

// The stored `role` of an event is the right the action used. Each of these
// roles is its own actor type; `owner` (personal access), no role at all (a
// sign-in, or a refusal before a role is known) and anything else is a person
// with no team role.
const TYPE_OF_ROLE = new Map([
  [PLATFORM_ADMIN_ROLE, PLATFORM_ADMIN_ROLE],
  [TEAM_ADMIN, 'team-admin'],
  ['user', 'team-member'],
  [SYSTEM_ROLE, SYSTEM_ROLE]
])

function actorTypeOf(role) {
  return TYPE_OF_ROLE.get(role) ?? PERSON
}

function roleFilterFor(actorType) {
  if (actorType === PERSON) {
    return { $nin: [...TYPE_OF_ROLE.keys()] }
  }

  return [...TYPE_OF_ROLE].find(([, type]) => type === actorType)[0]
}

function timeFilter({ from, to }) {
  return {
    ...(from && { $gte: from }),
    ...(to && { $lte: to })
  }
}

// The ids of the people whose display name holds the text, literally and
// ignoring case. `actorUserId` is the id of a person's `users` record.
async function actorIdsNamed(db, person) {
  const people = await db
    .collection('users')
    .find(
      { displayName: { $regex: escapeRegex(person), $options: 'i' } },
      { projection: { _id: 1 } }
    )
    .sort({ _id: 1 })
    .limit(MAX_PEOPLE_MATCHED)
    .toArray()

  return people.map(({ _id }) => _id.toString())
}

async function filterOf(db, query) {
  const { team, environment, action, actorType, person, from, to } = query
  const at = timeFilter({ from, to })

  return {
    ...(team && { teamId: team }),
    ...(environment && { environment }),
    ...(action && { action }),
    ...(actorType && { role: roleFilterFor(actorType) }),
    ...(person && { actorUserId: { $in: await actorIdsNamed(db, person) } }),
    ...(Object.keys(at).length > 0 && { at })
  }
}

// Record ids are strings, but a person's or team's `_id` is an ObjectId in
// the database, so a lookup asks for both forms of each id.
function idForms(ids) {
  return [
    ...ids,
    ...ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id))
  ]
}

function definedUnique(values) {
  return [...new Set(values.filter(Boolean))]
}

async function namesById(db, collection, ids, field) {
  if (ids.length === 0) {
    return new Map()
  }

  const found = await db
    .collection(collection)
    .find({ _id: { $in: idForms(ids) } }, { projection: { [field]: 1 } })
    .toArray()

  return new Map(found.map((doc) => [doc._id.toString(), doc[field] ?? null]))
}

async function namesByOid(db, oids) {
  if (oids.length === 0) {
    return new Map()
  }

  const found = await db
    .collection('users')
    .find({ oid: { $in: oids } }, { projection: { oid: 1, displayName: 1 } })
    .toArray()

  return new Map(
    found.map(({ oid, displayName }) => [oid, displayName ?? null])
  )
}

// The names a page shows, by what the events hold (design F "Shows": the
// backend stores only ids, so names are looked up here, for display only).
// The projections hold no email.
async function namesFor(db, found) {
  const [people, subjects, teams] = await Promise.all([
    namesById(
      db,
      'users',
      definedUnique(found.map((doc) => doc.actorUserId)),
      'displayName'
    ),
    namesByOid(db, definedUnique(found.map((doc) => doc.subjectOid))),
    namesById(
      db,
      'teams',
      definedUnique(found.map((doc) => doc.teamId)),
      'name'
    )
  ])

  return { people, subjects, teams }
}

function eventView(doc, { people, subjects, teams }) {
  return {
    id: doc._id.toString(),
    at: doc.at.toISOString(),
    action: doc.action,
    outcome: doc.outcome,
    code: doc.code ?? null,
    reason: doc.reason ?? null,
    resource: doc.resource,
    actor: {
      type: actorTypeOf(doc.role),
      displayName: people.get(doc.actorUserId) ?? null
    },
    subject: doc.subjectOid
      ? { displayName: subjects.get(doc.subjectOid) ?? null }
      : null,
    team: doc.teamId
      ? { id: doc.teamId, name: teams.get(doc.teamId) ?? null }
      : null,
    environment: doc.environment ?? null
  }
}

// What the filter form offers: every team by name, and the environments this
// instance deploys to.
async function filterOptions(db) {
  const teams = await db
    .collection('teams')
    .find({}, { projection: { name: 1 } })
    .sort({ normalisedName: 1, _id: 1 })
    .toArray()

  return {
    teams: teams.map((team) => ({ id: team._id.toString(), name: team.name })),
    environments: config.get('teamDeployment.environments')
  }
}

/**
 * One page of the audit log for a Platform Admin, newest first: who did what,
 * to whom, for which team and environment, and the outcome. The right is
 * checked first and a refusal is audited; reading the log is not. The people
 * and teams are named for display only; no id, object id, tenant, token or
 * request detail leaves here, and the `reason` is returned as it was stored.
 * `person` matches part of an actor's display name, literally and ignoring
 * case.
 * @param {import('mongodb').Db} db
 * @param {{actor: object, team?: string, environment?: string, action?: string, actorType?: string, person?: string, from?: Date, to?: Date, page?: number}} params - `actor` is the token's credentials; `from` and `to` are inclusive
 * @returns {Promise<{events: object[], page: number, pageSize: number, total: number, retentionDays: number, options: {teams: object[], environments: string[]}}>}
 */
export async function listAuditEvents(db, { actor, page = 1, ...query }) {
  await requirePlatformAdmin(db, actor)

  const filter = await filterOf(db, query)
  const auditEvents = db.collection('auditEvents')
  const [found, total, options] = await Promise.all([
    auditEvents
      .find(filter)
      .sort({ at: -1, _id: -1 })
      .skip((page - 1) * AUDIT_PAGE_SIZE)
      .limit(AUDIT_PAGE_SIZE)
      .toArray(),
    auditEvents.countDocuments(filter),
    filterOptions(db)
  ])
  const names = await namesFor(db, found)

  return {
    events: found.map((doc) => eventView(doc, names)),
    page,
    pageSize: AUDIT_PAGE_SIZE,
    total,
    retentionDays: config.get('audit.retentionDays'),
    options
  }
}
