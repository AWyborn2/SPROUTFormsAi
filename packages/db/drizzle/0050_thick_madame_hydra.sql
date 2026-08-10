CREATE TYPE "public"."import_row_outcome" AS ENUM('created', 'added_membership', 'reactivated', 'merged', 'duplicate', 'rejected');--> statement-breakpoint
CREATE TABLE "import_run_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"subject" text NOT NULL,
	"outcome" "import_row_outcome" NOT NULL,
	"reason" text,
	"detail" text,
	"user_id" uuid,
	"membership_id" uuid,
	"flagged" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"differences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"competencies_recorded" integer DEFAULT 0 NOT NULL,
	"competencies_skipped" integer DEFAULT 0 NOT NULL,
	"assessments_assigned" integer DEFAULT 0 NOT NULL,
	"seat_pool" text
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"started_by_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"rows_total" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_run_rows" ADD CONSTRAINT "import_run_rows_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run_rows" ADD CONSTRAINT "import_run_rows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run_rows" ADD CONSTRAINT "import_run_rows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_run_rows_run_idx" ON "import_run_rows" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "import_runs_org_idx" ON "import_runs" USING btree ("org_id");