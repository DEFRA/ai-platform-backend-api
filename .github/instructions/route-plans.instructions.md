---
description: 'Use when building or modifying any part of the routes/services/adapters/plugins behind the "three routes to a credential" journey (users, models, credentials, teams, team-deployments) — a route implementation typically also touches config, seed data and plugin registration, not just routes/services/adapters. Points to the authoritative plan docs and cross-repo design context so new work builds on what is already decided/built rather than re-deriving it.'
applyTo: 'src/**'
---

# The "three routes to a credential" journey

This service's core journey (browse a model, request a credential, manage a team's access) is documented in the plan
files owned by `ai-platform-frontend`, which build the frontend routes that are the entry point into this repo's API.
Read the relevant one before adding or changing anything the journey touches, rather than re-deriving the flow. That is
rarely just `routes`, `services` and `adapters`: past work has also touched `src/plugins/mongodb.js` (indexes, collections),
`src/plugins/router.js`, `src/config.js` (new config keys) and `src/common/seed/` (seed data).

**Built** (one file per category, in [ai-platform-frontend/docs/plans/implemented/](../../../ai-platform-frontend/docs/plans/implemented/)):

- [02-research-tier.md](../../../ai-platform-frontend/docs/plans/implemented/02-research-tier.md): `users`, `models`, `credentials`, the Azure APIM `CredentialIssuer`, the Key Vault `CredentialVault`, per-environment resolution (`AIP_ENVIRONMENTS`). Read before touching `adapters/azure/`, `credential-service.js` or `aip-environment.js`; it records the non-obvious APIM and ARM behaviour found against real Azure.
- [03-team-tier.md](../../../ai-platform-frontend/docs/plans/implemented/03-team-tier.md): `teams`, `team-deployments`, the `TenantOrchestrator` port and its GitHub adapter, verification, role enforcement and `rotate`. Read before touching `team-deployment-*.js`, `adapters/github/` or the desired-state builder.
- [04-catalogue-and-gateway.md](../../../ai-platform-frontend/docs/plans/implemented/04-catalogue-and-gateway.md): the `CatalogueSource` port, `catalogue-service.js`, and the `hosting`/`gateway` shape (`adapter` is renamed `gateway` everywhere except `src/adapters/`, where it is the design-pattern term). Read before touching either registry, `config.js`'s provisioning keys, the seed data or the backfill registry.
- [05-platform-and-gitops-pipeline.md](../../../ai-platform-frontend/docs/plans/implemented/05-platform-and-gitops-pipeline.md): the five repositories, Infradev, CDP dev config and operating notes.
- [06-shared-services-and-security.md](../../../ai-platform-frontend/docs/plans/implemented/06-shared-services-and-security.md): idempotency, audit, locks, backfills, security.
- [01-portal-journeys.md](../../../ai-platform-frontend/docs/plans/implemented/01-portal-journeys.md): the frontend pages that call this API.

**Not built** (one file): [ai-platform-frontend/docs/plans/remaining.md](../../../ai-platform-frontend/docs/plans/remaining.md).
Read it before starting any build story, to check whether the work is a refactor of something built and which items are
blocked or deferred.

Cross-repo context:

- [ai-platform-frontend/docs/ui-flow-three-routes.md](../../../ai-platform-frontend/docs/ui-flow-three-routes.md): the source UI flow (route paths, API contract, known gaps).
- [ai-platform-discovery-docs/docs/iac-baseline-plan.md](../../../ai-platform-discovery-docs/docs/iac-baseline-plan.md): the IaC baseline behind B15 and B16.
- [ai-platform-discovery-docs/src/content/design-orchestration.md](../../../ai-platform-discovery-docs/src/content/design-orchestration.md): design C. Every backend action is either the slow GitOps path (`TenantOrchestrator`) or the fast direct API path (`CredentialIssuer`); this split is why "connect to a dedicated team model" uses two ports.
- The matching frontend work: [ai-platform-frontend route-plans.instructions.md](../../../ai-platform-frontend/.github/instructions/route-plans.instructions.md).

## Keeping these plans current

The plan files in `ai-platform-frontend/docs/plans/` are the single source of truth for this journey; there is no copy in this
repo or in agent memory. When a backend change affects a feature covered there, edit the matching `implemented/NN-*.md` file or
move the item out of `remaining.md` into it, in the frontend repo, and follow the rules in the frontend's
[route-plans.instructions.md](../../../ai-platform-frontend/.github/instructions/route-plans.instructions.md#whenever-you-touch-a-plan-keep-the-folders-and-the-readme-in-sync).
