---
description: 'Use whenever you finish implementing a new route/service/adapter, or a cross-cutting backend capability — reminds you to update the shared implemented-features list new joiners read.'
applyTo: 'src/**'
---

# Keep the implemented-features list current

[ai-platform-frontend/docs/implemented-features.md](../../../ai-platform-frontend/docs/implemented-features.md)
is the one cross-repo list of what has been built so far in the AI Platform Portal, written for new
joiners — a short bullet-point index, not a duplicate of the detailed plan docs and READMEs it
links to. It lives in the frontend repo (the existing cross-repo docs hub), but covers both repos.

Update it whenever you ship something that changes the answer to "what does this platform do
today?":

- A route/plan moves from not-yet-implemented to implemented, or its shape changes materially (e.g.
  a refactor like Route 2's per-team-per-environment credential change) — update its row in the
  "Journey status at a glance" table and its route section.
- A new cross-cutting feature lands (a new shared mechanism like locks, backfills, audit events)
  that isn't tied to one route — add a bullet under "Cross-cutting platform features".

Keep entries to one or two lines with a link to the authoritative source (route plan, README
section, design-pack page) for detail — do not grow this file into a second copy of that detail.
Update the "Last updated" date at the top whenever you edit it.

This is separate from (and in addition to) keeping `routeN-plan.md` STATUS lines current — see
[route-plans.instructions.md](route-plans.instructions.md) for that mechanism.

## Then check the discovery repo's build state

Every route, service or adapter built here follows a design in `ai-platform-discovery-docs`, and
that repo records built state. After every implementation, once the steps above are done, check it
without being asked and add what is missing:

1. Compare what you built with `ai-platform-discovery-docs/src/content/build-stories.md` `#status`:
   the B01 to B10 rows, the paragraph for features built outside a numbered story, "Real Azure so
   far", the gaps list and the follow-on table (`#later`). Add or correct a row when a feature is
   missing, wrong or stale, and check any dated "Built by" or "State on" note in a design page the
   feature touches (for example `design-orchestration.md#catalogue-schema`).
2. Make it a separate, doc-only pull request in that repo and follow its
   `.github/copilot-instructions.md` "Every change: propagate, date and record" rules: sweep for
   contradicted statements, set `ms.date`, append to `docs/decision-history.md`, update
   `docs/design-pack-plan.md`, pin the copy in `test/site.test.js` with an `assertCopy` and an
   `assert.doesNotMatch` for superseded wording, then run `npm run lint`, `npm test` and
   `npm run check`. Never change application code from that repo.
3. Keep it minimal, concise and factual: a short clause per row or note, not a paragraph. Record
   built state only, never a new design direction. Read it from
   the released tags and `ai-platform-frontend/docs/implemented-features.md`, cite the version and
   date, and say "in an open pull request" for anything not yet merged or released. Built is not
   accepted and nothing is claimed as deployed unless it is.
4. If nothing needs changing, say "build status checked, no change" in your summary rather than
   skipping the check.
