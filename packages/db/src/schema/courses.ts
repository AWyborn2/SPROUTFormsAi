import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { CourseFileEntry } from '@formai/shared';
import { organizations, users } from './organizations.ts';
import { assessmentCases } from './assessments.ts';

/**
 * An uploaded course package — the reading a candidate does before an
 * assessment starts.
 *
 * The row is the package's catalogue entry; the bytes live in object storage
 * under `{orgId}/course-{id}/{path}`. `files` doubles as the serving
 * allowlist: the content route answers only paths this list names, so a
 * course can never be used to probe what else the org's prefix holds.
 *
 * `kind` decides how completion is judged. A `deck` (the packaged interactive
 * manual — detected by its `deck-stage` viewer) reports slide changes to the
 * player, and completion means every one of `slideCount` slides was visited.
 * A `scorm` or `html` package has no slide stream the player can see, so
 * completion is an explicit read-through confirmation instead.
 */
export const courses = pgTable(
  'courses',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    /** 'deck' | 'scorm' | 'html' — derived from the package at import. */
    kind: text().notNull(),
    /** Zip-relative path of the page the player's iframe opens. */
    launchPath: text('launch_path').notNull(),
    /** Slides in a deck package; null for kinds with no slide stream. */
    slideCount: integer('slide_count'),
    /** Every file in the package — path, size and the type it serves as. */
    files: jsonb().$type<CourseFileEntry[]>().notNull().default([]),
    totalBytes: integer('total_bytes').notNull(),
    /**
     * 'active' | 'archived'. Archived rather than deleted so a case that
     * recorded its reading against this course keeps a resolvable record;
     * an archived course stops being offered, linked and served.
     */
    status: text().notNull().default('active'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('courses_org_idx').on(t.orgId)],
);

/**
 * One case's reading record for one course.
 *
 * Kept per CASE rather than per person: the manual is read at the start of
 * each assessment (usually on the assessor's device), and a re-assessment
 * two years later should not inherit a tick from the last one. `visitedSlides`
 * accumulates monotonically — the PATCH route unions what the player reports
 * into what is stored — and `completedAt` is derived server-side, never
 * asserted by the client.
 */
export const assessmentCaseCourseProgress = pgTable(
  'assessment_case_course_progress',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => assessmentCases.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    /** Zero-based slide indexes seen so far, sorted, no duplicates. */
    visitedSlides: jsonb('visited_slides').$type<number[]>().notNull().default([]),
    startedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    /** Set once, when the completion rule for the course's kind is met. */
    completedAt: timestamp({ withTimezone: true }),
    /** Who was signed in when the record completed. */
    completedByUserId: uuid('completed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('case_course_progress_uq').on(t.caseId, t.courseId),
    index('case_course_progress_org_idx').on(t.orgId),
  ],
);
