ALTER TABLE "import_run_rows" RENAME COLUMN "competencies_skipped" TO "competencies_undated";--> statement-breakpoint
ALTER TABLE "competency_holders" ALTER COLUMN "granted_at" DROP NOT NULL;