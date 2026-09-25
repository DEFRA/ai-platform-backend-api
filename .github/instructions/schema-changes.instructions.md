---
description: 'Use when adding, renaming, or restructuring a field on a document persisted in MongoDB (services, seed data, or the mongodb plugin) — covers when an existing document will not have that field and how to keep it from silently breaking.'
applyTo: 'src/services/**, src/common/seed/**, src/common/backfills/**, src/plugins/mongodb.js'
---

# Schema changes and backward compatibility

MongoDB has no enforced schema, so a new/renamed field is only "safe" once both of these are true
for every document already in the database:

1. Code that reads the field tolerates it being absent (`doc.field ?? default`, optional chaining)
   rather than assuming every document already has it.
2. If anything will query, index, or report on the field's value (not just read it defensively),
   add a backfill entry to [`src/common/backfills/registry.js`](../../src/common/backfills/registry.js)
   so existing documents get it — see that file's doc comment and the README's "Schema backfills"
   section for the entry shape. `runBackfills` applies each entry once per environment automatically
   on the next deploy; there is no separate migration step to run by hand.

Add a backfill entry whenever you:
- Add a field to a document shape in any `src/services/*.js` file that persists to Mongo.
- Add a `$setOnInsert` field to an upsert — it only applies to brand new documents; anything already
  matched by the upsert keeps its old shape, `$setOnInsert` never touches it.
- Rename or restructure a field — add the new field via a backfill, keep reading the old field as a
  fallback until you've confirmed the backfill has run everywhere, then remove the fallback in a
  later change (the expand -> backfill -> contract pattern the README documents).

You don't need a backfill for a field that's fine to stay optional forever and is already read
defensively everywhere — only add one once something will start depending on every document having
a concrete value.
