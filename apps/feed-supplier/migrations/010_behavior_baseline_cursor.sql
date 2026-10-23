-- Lists without platform times are read in full before a behavior source publishes anything;
-- the read can span several checks (ADR-0037).
ALTER TABLE behavior_sources ADD COLUMN IF NOT EXISTS baseline_cursor varchar(2048);

ALTER TABLE behavior_sources DROP CONSTRAINT IF EXISTS behavior_platform_known;
ALTER TABLE behavior_sources
  ADD CONSTRAINT behavior_platform_known CHECK (platform IN ('bilibili', 'zhihu'));
