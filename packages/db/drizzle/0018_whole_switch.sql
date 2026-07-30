CREATE TABLE "induction_booking_starters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"starter_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "induction_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"induction_date" text NOT NULL,
	"seats" integer NOT NULL,
	"external_reference" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"booked_by_user_id" uuid,
	"booked_by_api_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "induction_booking_starters" ADD CONSTRAINT "induction_booking_starters_booking_id_induction_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."induction_bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "induction_booking_starters" ADD CONSTRAINT "induction_booking_starters_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "induction_bookings" ADD CONSTRAINT "induction_bookings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "induction_bookings" ADD CONSTRAINT "induction_bookings_booked_by_user_id_users_id_fk" FOREIGN KEY ("booked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "induction_bookings" ADD CONSTRAINT "induction_bookings_booked_by_api_key_id_api_keys_id_fk" FOREIGN KEY ("booked_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "induction_booking_starters_uq" ON "induction_booking_starters" USING btree ("booking_id","submission_id");--> statement-breakpoint
CREATE INDEX "induction_booking_starters_submission_idx" ON "induction_booking_starters" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "induction_bookings_org_idx" ON "induction_bookings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "induction_bookings_org_date_idx" ON "induction_bookings" USING btree ("org_id","induction_date");