---
description: 'Use when building or modifying any part of the routes/services/adapters/plugins behind the "three routes to a credential" journey (users, models, credentials, teams, team-deployments) — a route implementation typically also touches config, seed data and plugin registration, not just routes/services/adapters. Points to the authoritative plan docs and cross-repo design context so new work builds on what is already decided/built rather than re-deriving it.'
applyTo: 'src/**'
---

# The "three routes to a credential" journey

This service's core journey (browse a model, request a credential, manage a team's access) is
specified end-to-end in committed plan docs owned by `ai-platform-frontend` (the frontend routes
they build are the entry point into this repo's API surface) — read the relevant one before
adding or changing anything the journey touches, rather than re-deriving the flow from scratch.
That's rarely just `routes`/`services`/`adapters`: past work under this journey has also touched
`src/plugins/mongodb.js` (new indexes/collections), `src/plugins/router.js` (registering new route
plugins), `src/config.js` (new config keys) and `src/common/seed/models.seed.json` (seed data for
new tiers/environments) — check the plan's own "Relevant files" and "Steps" sections for the exact
list on a given route:

- [ai-platform-frontend/docs/plans/route1-plan.md](../../../ai-platform-frontend/docs/plans/route1-plan.md) — research tier shared model access: `users`/`models`/`credentials` routes and services. Implemented.
- [ai-platform-frontend/docs/plans/route2-plan.md](../../../ai-platform-frontend/docs/plans/route2-plan.md) — team tier, first person in a team: `teams`, `team-deployments`, the `TenantOrchestrator` port. Implemented.
- [ai-platform-frontend/docs/plans/route3-plan.md](../../../ai-platform-frontend/docs/plans/route3-plan.md) — team tier, joining a team: role enforcement (`getMemberRole`), the `rotate` operation. Not yet implemented.
- [ai-platform-frontend/docs/plans/route0-welcome-plan.md](../../../ai-platform-frontend/docs/plans/route0-welcome-plan.md) — frontend-only home page, no backend changes.

Each plan's "STATUS" line at the top records whether it has been built. Cross-repo context:

- [ai-platform-frontend/docs/ui-flow-three-routes.md](../../../ai-platform-frontend/docs/ui-flow-three-routes.md) — the source UI flow diagrams (route paths, API contract, known gaps), with the original images, captured in text since the originals aren't in any repo.
- [ai-platform-discovery-docs/src/content/design-orchestration.md](../../../ai-platform-discovery-docs/src/content/design-orchestration.md) — design C: every backend action is either the slow GitOps path (team/model provisioning, `TenantOrchestrator`) or the fast Direct API path (`CredentialIssuer` — issue/renew/rotate/revoke). This split is why "connect to a dedicated team model" is modelled as two ports, not one.
- The matching frontend work for each route lives in `ai-platform-frontend` — see its [.github/instructions/route-plans.instructions.md](../../../ai-platform-frontend/.github/instructions/route-plans.instructions.md).

## Keeping these plans current

The plan docs in `ai-platform-frontend/docs/plans/` are the single source of truth for this
journey — there is no separate copy in this repo or in agent memory. When a design change affects
a backend route/service/adapter covered here, edit the relevant `routeN-plan.md` in the frontend
repo directly (update its `STATUS`/decisions, add a dated note) rather than tracking the change
separately here.
