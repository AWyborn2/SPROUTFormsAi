ALTER TABLE "member_profiles" ADD COLUMN "employee_number" text;--> statement-breakpoint
ALTER TABLE "member_profiles" ADD COLUMN "swipe_card_number" text;--> statement-breakpoint
CREATE UNIQUE INDEX "member_profiles_org_employee_number_uq" ON "member_profiles" USING btree ("org_id",lower("employee_number")) WHERE "member_profiles"."employee_number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "member_profiles_org_swipe_card_number_uq" ON "member_profiles" USING btree ("org_id",lower("swipe_card_number")) WHERE "member_profiles"."swipe_card_number" IS NOT NULL;