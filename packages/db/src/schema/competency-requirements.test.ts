/**
 * U1 (KTD1, KTD2): the four-scope `competency_requirements` table, pinned at
 * the two layers this package owns.
 *
 * The DECLARED shape (drizzle table config) — nullable scope columns, the
 * at-most-one-scope CHECK, four PARTIAL unique indexes, FK postures — and the
 * MIGRATION SQL that carries it to a database. The scenarios a live database
 * would prove (CHECK rejects two scopes set, each partial index rejects its
 * own duplicate while permitting the same competency at another scope, the
 * compatibility view reads/writes role rows only) have no DB harness in this
 * repo, so they are pinned by the constraint and view TEXT the migration
 * applies: the SQL below IS the behaviour, verbatim, and an edit that weakens
 * a constraint has to disagree with this file to land.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { competencyRequirements } from './taxonomy.ts';

const DRIZZLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const MIGRATION = '0060_worried_silver_sable.sql';

const dialect = new PgDialect();
const config = getTableConfig(competencyRequirements);

/*
  Columns declared without an explicit db name (`orgId: uuid()`) report their
  TS key from `getTableConfig`; the snake_case mapping is applied by the
  client's `casing: 'snake_case'` option (drizzle.config.ts / client.ts) at
  query time. Normalise here so the assertions speak the DATABASE's names —
  the ones the migration SQL and a psql session actually show.
*/
const snake = (name: string) => name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

describe('competency_requirements — declared shape (KTD1)', () => {
  it('is the renamed table, not a sibling of the old one', () => {
    expect(config.name).toBe('competency_requirements');
  });

  it('carries three NULLABLE scope columns and keeps org/competency/tier NOT NULL', () => {
    const notNullByName = Object.fromEntries(config.columns.map((c) => [snake(c.name), c.notNull]));
    // All three null IS the org scope (KTD1) — so none of the scope columns
    // may be NOT NULL, and nothing else lost its constraint in the rename.
    expect(notNullByName).toEqual({
      id: true,
      org_id: true,
      role_id: false,
      location_id: false,
      department_id: false,
      competency_id: true,
      tier: true,
      created_at: true,
    });
  });

  it('CHECKs at most one scope column non-null — two scopes is a corrupt row, not a richer one', () => {
    expect(config.checks).toHaveLength(1);
    const check = config.checks[0]!;
    expect(check.name).toBe('competency_requirements_one_scope_ck');
    const sql = dialect.sqlToQuery(check.value).sql;
    expect(sql).toContain('num_nonnulls');
    expect(sql).toContain('"role_id"');
    expect(sql).toContain('"location_id"');
    expect(sql).toContain('"department_id"');
    expect(sql).toContain('<= 1');
  });

  it('replaces the single unique index with FOUR partial ones, one per scope (KTD1)', () => {
    const byName = new Map(config.indexes.map((i) => [i.config.name, i.config]));

    // Postgres treats NULLs as distinct, so each uniqueness claim must be
    // partial — scoped to rows where its own scope column is set — and the
    // org claim to rows where none is. Cross-scope duplicates stay LEGAL
    // (KTD2): no index spans two scopes.
    const expectPartialUnique = (name: string, columns: string[], where: string) => {
      const idx = byName.get(name);
      expect(idx, name).toBeDefined();
      expect(idx!.unique, name).toBe(true);
      expect(
        idx!.columns.map((c) => snake((c as { name: string }).name)),
        name,
      ).toEqual(columns);
      expect(idx!.where, name).toBeDefined();
      expect(dialect.sqlToQuery(idx!.where!).sql, name).toBe(where);
    };

    expectPartialUnique(
      'competency_requirements_role_uq',
      ['role_id', 'competency_id'],
      '"competency_requirements"."role_id" IS NOT NULL',
    );
    expectPartialUnique(
      'competency_requirements_location_uq',
      ['location_id', 'competency_id'],
      '"competency_requirements"."location_id" IS NOT NULL',
    );
    expectPartialUnique(
      'competency_requirements_department_uq',
      ['department_id', 'competency_id'],
      '"competency_requirements"."department_id" IS NOT NULL',
    );
    expectPartialUnique(
      'competency_requirements_org_uq',
      ['org_id', 'competency_id'],
      '"competency_requirements"."role_id" IS NULL AND "competency_requirements"."location_id" IS NULL AND "competency_requirements"."department_id" IS NULL',
    );

    // The plain secondary indexes survive the rename, plus one per new scope
    // column — reads by scope must not become table scans.
    for (const name of [
      'competency_requirements_org_idx',
      'competency_requirements_role_idx',
      'competency_requirements_location_idx',
      'competency_requirements_department_idx',
      'competency_requirements_competency_idx',
    ]) {
      const idx = byName.get(name);
      expect(idx, name).toBeDefined();
      expect(idx!.unique, name).toBe(false);
    }
    expect(config.indexes).toHaveLength(9);
  });

  it('keeps the shipped FK postures: role cascades, location/department restrict (KTD1)', () => {
    const onDeleteByColumn = Object.fromEntries(
      config.foreignKeys.map((fk) => {
        const ref = fk.reference();
        return [snake(ref.columns[0]!.name), fk.onDelete];
      }),
    );
    expect(onDeleteByColumn).toEqual({
      org_id: 'cascade',
      role_id: 'cascade', // a deleted Role takes its own requirements with it, as shipped
      location_id: 'restrict', // retire-not-delete values refuse deletion while required-on
      department_id: 'restrict',
      competency_id: 'cascade', // unreachable while depended-on — the DELETE route 409s first
    });
  });
});

describe('0059 migration — the SQL that carries the shape (U1)', () => {
  const read = () => readFile(path.join(DRIZZLE_DIR, MIGRATION), 'utf8');

  it('RENAMES the table — any rows survive; the zero-rows premise is never load-bearing', async () => {
    const sql = await read();
    expect(sql).toContain('ALTER TABLE "role_required_competencies" RENAME TO "competency_requirements";');
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/CREATE TABLE "competency_requirements"/i);
  });

  it('applies the CHECK, the nullable scope columns, and all four partial unique indexes', async () => {
    const sql = await read();
    expect(sql).toContain('ALTER COLUMN "role_id" DROP NOT NULL');
    expect(sql).toContain('ADD COLUMN "location_id" uuid');
    expect(sql).toContain('ADD COLUMN "department_id" uuid');
    expect(sql).toContain(
      'CHECK (num_nonnulls("competency_requirements"."role_id", "competency_requirements"."location_id", "competency_requirements"."department_id") <= 1)',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "competency_requirements_role_uq" ON "competency_requirements" USING btree ("role_id","competency_id") WHERE "competency_requirements"."role_id" IS NOT NULL;',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "competency_requirements_location_uq" ON "competency_requirements" USING btree ("location_id","competency_id") WHERE "competency_requirements"."location_id" IS NOT NULL;',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "competency_requirements_department_uq" ON "competency_requirements" USING btree ("department_id","competency_id") WHERE "competency_requirements"."department_id" IS NOT NULL;',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "competency_requirements_org_uq" ON "competency_requirements" USING btree ("org_id","competency_id") WHERE "competency_requirements"."role_id" IS NULL AND "competency_requirements"."location_id" IS NULL AND "competency_requirements"."department_id" IS NULL;',
    );
    // FK postures in the applied DDL, matching the declared shape above.
    expect(sql).toMatch(/"location_id"\) REFERENCES "public"\."locations"\("id"\) ON DELETE restrict/);
    expect(sql).toMatch(/"department_id"\) REFERENCES "public"\."departments"\("id"\) ON DELETE restrict/);
    expect(sql).toMatch(/"role_id"\) REFERENCES "public"\."roles"\("id"\) ON DELETE cascade/);
  });

  it('bridges the deploy window with the one-release compatibility view', async () => {
    /*
      A rename breaks OLD servers the moment it applies — standing, compliance
      and assignment all read the old name until the new build is live. The
      bridge is a simple single-table view, which Postgres makes AUTO-UPDATABLE:
      old code reads AND writes `role_required_competencies` through it, its
      inserts landing with role_id set and the new scope columns null (the
      CHECK accepts that). Dropped in the NEXT round's first migration.

      ONE DIRECTION ONLY (review-corrected): the view saves old-code-AFTER-
      migrate and nothing else. New code deployed BEFORE the migration reads a
      table that does not exist. The migration file must SAY so, because the
      release order is a hard precondition and a header that claims otherwise
      is how a deploy gets sequenced wrong.
    */
    const sql = await read();
    const viewAt = sql.indexOf('CREATE VIEW "role_required_competencies"');
    expect(viewAt).toBeGreaterThan(-1);
    const view = sql.slice(viewAt);
    // The old table's exact column list — nothing more, so old code sees the
    // shape it compiled against; role rows only, so org/location/department
    // requirements stay invisible to servers that predate scopes.
    expect(view).toContain('SELECT "id", "org_id", "role_id", "competency_id", "tier", "created_at"');
    expect(view).toContain('FROM "competency_requirements"');
    expect(view).toContain('WHERE "role_id" IS NOT NULL');
    // No aggregates/joins/DISTINCT — what keeps the view auto-updatable.
    expect(view).not.toMatch(/JOIN|GROUP BY|DISTINCT|UNION/i);
    // The drop-next-round intent is written into the migration itself.
    expect(sql).toMatch(/next round's first migration drops this view/i);
    // …and so is the ordering precondition. The bridge is one-directional, so
    // the header must not read as "either order is fine".
    expect(sql).toMatch(/MIGRATE FIRST, THEN DEPLOY/i);
    expect(sql).not.toMatch(/neither ordering/i);
  });
});
