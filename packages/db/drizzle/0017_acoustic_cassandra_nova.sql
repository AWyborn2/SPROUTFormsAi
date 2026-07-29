ALTER TABLE "invites" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "invitee_name" text DEFAULT '' NOT NULL;