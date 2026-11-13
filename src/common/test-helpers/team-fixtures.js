import { randomUUID } from 'node:crypto'

import { signInAs } from '#/common/test-helpers/portal-token.js'
import { buildOperation } from '#/operations/operation-factory.js'

const ENTRA_TENANT_ID = '6f504113-6b64-43f2-ade9-242e05780007'
const TARGET_REPOSITORY = 'DEFRA/ai-platform-tenants'
const DEFAULT_ITEM = { entryId: 'e1', modelSlug: 'gpt-4o', change: 'add' }
// Enough random characters that two teams of one test never share a name.
const NAME_SUFFIX_LENGTH = 6

/**
 * Helpers for route tests of a team's environments and operations: people
 * who have signed in, teams they belong to, and operations a team's file
 * holds or held. Call it with a server wrapped by `withTestUsers`.
 * @param {import('@hapi/hapi').Server} server
 */
export function createTeamFixtures(server) {
  const userIds = new Map()

  // Signs a person in as sign-in does; their record id is then their
  // `x-user-id` (the label stands for a person nobody signed in).
  async function signIn(label) {
    const { result } = await signInAs(server, {
      oid: randomUUID(),
      tid: ENTRA_TENANT_ID,
      email: `${label}@defra.gov.uk`,
      displayName: `Name of ${label}`
    })

    userIds.set(label, result.user._id.toString())
  }

  function as(label) {
    return { 'x-user-id': userIds.get(label) ?? label }
  }

  function asWithKey(label) {
    return { ...as(label), 'idempotency-key': randomUUID() }
  }

  // A team created by the named person, who is its Admin.
  async function newTeam(label) {
    await signIn(label)

    const { result } = await server.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: asWithKey(label),
      payload: {
        name: `Fixture ${label} ${randomUUID().slice(0, NAME_SUFFIX_LENGTH)}`,
        serviceCode: 'ABC'
      }
    })

    return {
      teamId: result.team._id.toString(),
      slug: result.team.slug,
      admin: label
    }
  }

  async function addMember(team, label, role = 'user') {
    await signIn(label)
    await server.db.collection('teamMembers').insertOne({
      teamId: team.teamId,
      userId: userIds.get(label),
      role,
      status: 'active'
    })
  }

  // An operation on the team's file, created `minute` minutes into the hour
  // of 2026-11-12 10:00; `requestedBy` names a signed-in person.
  function seedOperation(team, options) {
    return insertOperation(server, userIds, team, options)
  }

  return {
    signIn,
    as,
    asWithKey,
    newTeam,
    addMember,
    seedOperation
  }
}

async function insertOperation(
  server,
  userIds,
  team,
  { minute, requestedBy, items = [DEFAULT_ITEM], ...overrides }
) {
  const now = `2026-11-12T10:${String(minute).padStart(2, '0')}:00.000Z`
  const environment = overrides.environment ?? 'infradev'
  const operation = {
    ...buildOperation({
      type: 'team-file.write',
      state: 'active',
      teamId: team.teamId,
      environment,
      target: {
        repository: TARGET_REPOSITORY,
        team: team.slug,
        path: `environments/${environment}/${team.slug}.json`
      },
      items,
      requestedBy: 'entra:00000000-0000-4000-8000-000000000001',
      requestedByUserId: requestedBy ? userIds.get(requestedBy) : undefined,
      now,
      idempotencyKeys: [randomUUID()]
    }),
    ...overrides
  }

  await server.db.collection('operations').insertOne(operation)

  return operation
}
