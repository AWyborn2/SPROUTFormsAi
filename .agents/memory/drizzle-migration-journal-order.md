---
name: Drizzle migration journal ordering pitfall
description: When the _journal.json is written before the .sql file in the same batch, drizzle records the migration as applied without executing the DDL.
---

## The rule
Never write or update `_journal.json` in the same batch as the corresponding `.sql` file if the journal entry is committed first. Drizzle's `migrate()` uses `__drizzle_migrations` in the DB to decide what to skip — if the hash is already recorded, the SQL file is never run, even though the DB columns don't exist.

**Why:** In a previous session the journal was written and `db:migrate` was run, which recorded the migration hash in `__drizzle_migrations`. The actual ALTER TABLE SQL ran against the DB in the same call, but the columns never appeared (possibly a session reset or DB restart afterward). On the next session, `db:migrate` saw the hash already present and skipped re-execution, so the columns stayed missing and every org-related insert threw a 500.

**How to apply:**
- After any suspicion that a migration was skipped: run `psql $DATABASE_URL -c "\d <table>"` and compare against the schema file. Don't trust the journal or `__drizzle_migrations` alone.
- If columns are missing but the migration is recorded as applied, apply the DDL directly with `psql $DATABASE_URL -c "ALTER TABLE ... ADD COLUMN IF NOT EXISTS ..."`. This is safe and idempotent.
- Dev plan switcher endpoint lives at `POST /org/plan` (inside `apps/api/src/routes/org.ts`), not a separate `/dev/` prefix.
