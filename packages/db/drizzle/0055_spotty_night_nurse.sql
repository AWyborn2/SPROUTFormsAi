ALTER TABLE "import_runs" ADD COLUMN "status" text DEFAULT 'running' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "failure_reason" text;--> statement-breakpoint
/*
  BACKFILL BEFORE THE INDEX, and it is not optional.

  Every run that already exists ran to completion inside its HTTP request —
  there was no other way to run one — so the column default of 'running' is
  wrong for all of them. Left alone it would do two damaging things at once:
  make the guard below refuse every future import for any organisation that has
  ever run one, and fail the CREATE UNIQUE INDEX outright for any organisation
  that has run two.

  A run with no `completed_at` in the old world is one whose process died
  mid-write, which is exactly what the new `failed` state is for. Reporting it
  as failed is the honest reading: nothing is going to finish it.
*/
UPDATE "import_runs" SET "status" = 'completed', "heartbeat_at" = "completed_at" WHERE "completed_at" IS NOT NULL;--> statement-breakpoint
UPDATE "import_runs" SET "status" = 'failed', "failure_reason" = 'abandoned', "heartbeat_at" = "started_at" WHERE "completed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "import_runs_one_active_per_org" ON "import_runs" USING btree ("org_id") WHERE status = 'running';
