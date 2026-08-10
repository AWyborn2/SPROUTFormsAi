-- U8 — retire the free-text location stream in favour of location_id.
--
-- HALT-ON-UNRESOLVABLE. Dropping this column is irreversible, so refuse if any
-- case still carries a stream that was never resolved to a managed Location
-- (location_stream set, location_id null). That is exactly the state the data
-- migration (scripts/migrate-location-streams.mjs) exists to clear; if it did
-- not run, or could not match a stream to a Location, we stop here rather than
-- silently drop where a case was assessed. A row with BOTH set is fine — the
-- pointer has been captured and the old text is now redundant.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "assessment_cases"
    WHERE "location_stream" IS NOT NULL AND "location_stream" <> ''
      AND "location_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Unresolved location_stream on assessment_cases: run scripts/migrate-location-streams.mjs before this migration';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "assessment_cases" DROP COLUMN "location_stream";
