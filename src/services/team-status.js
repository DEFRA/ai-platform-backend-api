/**
 * A team's lifecycle status, stored as `teams.status` (design F, B31). Active
 * is the working state; a Platform Admin moves a team to `disabled` or
 * `pending-removal`. A team written before the field existed has none, and
 * reads as active (the `2026-11-12-teams-status-default` backfill sets it).
 */
export const TEAM_STATUS = Object.freeze({
  active: 'active',
  disabled: 'disabled',
  pendingRemoval: 'pending-removal'
})

/**
 * The team's status, `active` when it has none.
 * @param {{status?: string}|null|undefined} team
 * @returns {string}
 */
export function statusOf(team) {
  return team?.status ?? TEAM_STATUS.active
}
