---
description: 'Use when changing the GitOps message contracts, the operations modules or the SQS and SNS adapters: the vendored command and event schemas, Ajv validation, deduplication IDs, FIFO message groups and logging rules.'
applyTo: 'src/contracts/**, src/operations/**, src/adapters/sqs/**, src/adapters/sns/**'
---

# Message contracts

The backend and the GitOps worker talk through FIFO topics and queues, one owner each (CDP allows one service per
queue): the backend publishes to its topic `aip_gitops_commands` and reads its own queue `aip_gitops_events`; the worker
consumes its own queue `aip_gitops_commands_worker` and publishes to its topic `aip_gitops_events_worker`; the workflows
also send to the backend's events queue through a federated identity. CDP subscribes with raw delivery, so a queue body is
the message itself. They use the `aip.gitops.command/1` and `aip.gitops.event/1` schemas. The design is
[async-operations-plan.md](../../../ai-platform-discovery-docs/docs/async-operations-plan.md) section 5.

- **The schemas are vendored.** `src/contracts/aip-gitops/` is a copy of `ai-platform-infra/schemas/messages/` at the ref in
  its `VERSION` file. Change it only with `npm run contracts:sync -- {ref}`; `npm run contracts:check` fails on any difference.
  Never edit a schema in this repo.
- **Additive only.** A new optional field or status is allowed; renaming, removing or tightening one is not, because the
  worker and the workflows deploy on their own schedule.
- **Validate with Ajv** (`src/contracts/message-validators.js`) before publishing a command and before applying an event.
  A command that fails validation is a bug and throws; an invalid event is logged and acknowledged, not retried.
- **Deduplication.** `commandId` (UUIDv7, created with its outbox entry and kept when the entry is republished) is the FIFO
  deduplication ID of a command (SNS publish), so a new send is delivered and only a republish collapses. `eventId` is the deduplication ID
  of an event, and the handler also skips an event whose `eventId` is already in the operation's history.
- **Message groups.** A command's group is `{environment}/{team}` (`team` is `platform` or `tenants` for a pin). An event's group is
  the operation ID, the commit SHA for `break-glass`, or the environment for `pause`.
- **People are identifiers only**: `requestedBy` is `entra:{oid}`, `app:{name}` or `github:{id}`. Never put a name or email
  in a message.
- **Never log a document or a token.** Log the operation ID, `commandId`, `eventId`, type, status and state; never the team
  file `document`, an installation token or a queue message body.
- **No backfill.** A contract or operations change needs no [dated backfill](schema-changes.instructions.md) while nothing is
  live; delete old fields and states rather than mapping them.
