CREATE TYPE "public"."date_format" AS ENUM('dmy', 'mdy');--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "date_format" date_format DEFAULT 'dmy' NOT NULL;