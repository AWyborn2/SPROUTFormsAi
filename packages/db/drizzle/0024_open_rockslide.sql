ALTER TABLE "assessment_tools" ADD COLUMN "assessor_stream_competency_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;
-- No backfill. An empty object is the CORRECT value for every existing tool:
-- none of them varied their assessor requirements by location, and the
-- resolver treats an empty map as "this rule does not depend on where" rather
-- than as an unchecked gap. So nothing starts warning the day this ships.