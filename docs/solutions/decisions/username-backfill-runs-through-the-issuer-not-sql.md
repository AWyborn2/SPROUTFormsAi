---
title: The username backfill runs through the issuing function, not in SQL
date: 2026-08-06
category: decisions
module: auth
problem_type: design_decision
component: service_object
symptoms:
  - "A data migration would have to reimplement collision handling in SQL"
  - "Two users named Jane Smith need different usernames, decided at write time"
  - "Existing users predate the column and have no username to sign in with"
root_cause: design_decision
resolution_type: design_choice
severity: medium
related_components: [api-auth, db-migrations, member-profiles]
tags: [username, backfill, data-migration, collision-handling, u27]
---

# The username backfill runs through the issuing function, not in SQL

## The decision

Migration `0039` adds `users.username` as a **nullable** column with a unique
constraint and backfills **nothing**. Existing rows get their username from
`backfillUsername` in [apps/api/src/lib/username.ts](../../../apps/api/src/lib/username.ts) —
the same function that issues one at every insert site — rather than from an
`UPDATE ... SET username = ...` in the migration.

```sql
-- 0039, in full
ALTER TABLE "users" ADD COLUMN "username" text;
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");
```

## Why not backfill in SQL

The obvious migration writes `lower(first) || lower(last)` for every row. It
fails on the case the feature exists for.

**Usernames collide, and resolving a collision is a write-time decision.** Two
people named Jane Smith need `janesmith` and `janesmith4817`; which one gets the
bare stem depends on who is written first. Expressing that in SQL means a window
function to rank duplicates, a suffix generator, and a retry for the case where
the generated suffix itself collides with a username somebody already holds.
That is the issuing function, rewritten in a second language, in a file nobody
will ever run again — and the two implementations only have to disagree once to
put two people on one credential.

**The retry is the whole mechanism.** `backfillUsername` writes a candidate,
catches the unique violation on `users_username_unique`, and tries a fresh
suffix, up to `MAX_ATTEMPTS`. It lets the DATABASE arbitrate rather than reading
the table first and hoping nothing changes in between — which is the same reason
seat checks hold a row lock. A SQL backfill computing every username in one
statement has no equivalent: it either takes the whole table's uniqueness on
trust or serialises itself.

**Nullable is not a compromise.** A null username means "not yet issued", and
sign-in already accepts an email address, so nobody is locked out while the
backfill runs. Making the column `NOT NULL` would have forced the backfill INTO
the migration, which is the decision this avoids.

## Where the backfill actually runs

`backfillUsername(db, user)` is idempotent — it returns null immediately for a
user who already has one — so it is safe to run repeatedly and safe to run
against a table that is being written to at the same time. It takes a database
handle rather than importing one, so it runs on a transaction where a caller has
one.

Every site that creates a `users` row goes through `insertUserWithUsername`
instead, which issues in the SAME transaction as the row it belongs to —
self-signup (`routes/auth.ts`), invite acceptance (`routes/invites.ts`), the
workforce import (`lib/member-create.ts`) and tenant provisioning
(`auth/tenant-provisioning.ts`). No `users` row can land without one.

## What a future reader needs to know

- **The suffix is four digits** (`SUFFIX_DIGITS`), and `MAX_ATTEMPTS` is 8.
  After eight collisions on one stem it raises `UsernameExhaustedError` rather
  than looping — a name colliding eight times in a row is a signal, not a
  retry-harder situation.
- **Usernames are case-folded at generation**, and login compares them
  case-sensitively. That works only because every issued username is already
  lowercase; a username written by any other path would break the comparison.
- **If the column is ever made `NOT NULL`**, the backfill has to have completed
  first, and that migration must be its own — separate from the one adding the
  constraint — because a constraint added in the same transaction as the writes
  that satisfy it will see the pre-write state.

## Related

- The same reasoning appears in migration `0042`, a data-only migration that
  carries a journal entry and SQL but **no snapshot**, following the repo's own
  precedent in `0012_seed_assessment_roles`.
