# Specifications

This folder stores feature and technical specification documents (`.md`) for `ai-platform-backend-api`. Use it to capture design intent *before* implementation so both humans and AI coding agents (GitHub Copilot) can reference agreed requirements and constraints.

## Conventions

- One file per feature/change: `NNN-short-title.md` (e.g. `001-credential-reconciliation-job.md`), numbered sequentially.
- Keep specs focused: problem statement, requirements/acceptance criteria, and any constraints or out-of-scope items. Avoid duplicating implementation detail that belongs in code comments or [.github/copilot-instructions.md](../copilot-instructions.md).
- Reference relevant existing spec files from PR descriptions so reviewers (and AI agents) have context.
- Update or supersede a spec (don't silently rewrite history) if requirements change after implementation starts — link to the superseding doc.

## Shared cross-repo specs

Some specs (e.g. [mvp-portal-ui-api-scope.md](./mvp-portal-ui-api-scope.md)) originate outside this repo and describe both the frontend and backend services together. When such a spec is added here:

- Keep it as a faithful, unannotated copy of the source document (don't delete frontend sections or add repo-specific notes to it — other readers may need the full, original picture).
- Add a short scoping section to [copilot-instructions.md](../copilot-instructions.md) telling the agent which sections apply here vs. belong to the frontend repo, and noting where the frontend's own copy lives.

## Template

```markdown
# <Title>

## Status
Draft | Accepted | Superseded by <link>

## Problem
What problem this addresses and why now.

## Requirements
- Bullet list of must-have behaviour / acceptance criteria

## Out of Scope
- What this explicitly does not cover

## Notes
Links to related specs, ADRs, or discussions.
```
