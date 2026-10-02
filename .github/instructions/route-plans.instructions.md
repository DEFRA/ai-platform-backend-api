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
- [ai-platform-frontend/docs/plans/route3-plan.md](../../../ai-platform-frontend/docs/plans/route3-plan.md) — team tier, joining a team: role enforcement (`getMemberRole`), the `rotate` operation. Implemented.
- [ai-platform-frontend/docs/plans/route0-welcome-plan.md](../../../ai-platform-frontend/docs/plans/route0-welcome-plan.md) — frontend-only home page, no backend changes.

Cross-cutting plans under `docs/plans/integration/` are not journey routes, but they replace the
ports and adapters the routes above call:

- [ai-platform-frontend/docs/plans/integration/research-tier-integration-plan.md](../../../ai-platform-frontend/docs/plans/integration/research-tier-integration-plan.md) — replaces `mock-credential-issuer.js` with a real Azure APIM ARM adapter, moves the model catalogue from `models.seed.json` to a GitHub-hosted `CatalogueSource` port, and adds Key Vault credential persistence with an audited reveal endpoint. Phase 0 (Azure setup), Phase 1 (`CredentialIssuer` registry/Azure adapter), Phase 2 (`CatalogueSource`/`catalogue-service.js` sync, real catalogue content pushed and tagged `v0.1.0` in `ai-platform-infra`) and Phase 3 (`CredentialVault` port/registry, Key Vault adapter, `POST /v1/credentials/{id}/reveal`) complete; Phase 4 (ARM liveness reconcile) and Phase 6 (CDP deployment) are **deferred, not removed** (user decision) — still valid future work, don't start them without being asked, and don't assume Phase 6 automatically follows Phase 5 (no deployment decision has been made). Next up is a live local smoke test against the real sandbox resources (see the backend README's "Testing against live Azure resources"), then Phase 5 (trimmed - its "deployment not live" item depends on Phase 4's liveness data, which doesn't exist yet). Read before touching `adapters/`, `models-service.js`, `credential-service.js` or the seed data — it corrects several natural but wrong assumptions about how APIM is called, and its STATUS note records concrete deviations (Foundry hostname, operation URL templates, policy XML escaping, and the APIM gateway turning out to be publicly reachable rather than the private-VIP the doc originally assumed) found during Phase 0.

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
