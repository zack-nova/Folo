-- Douyin follows and favorites are read through the douyin-reader sidecar (ADR-0037).
ALTER TABLE behavior_sources DROP CONSTRAINT IF EXISTS behavior_platform_known;
ALTER TABLE behavior_sources
  ADD CONSTRAINT behavior_platform_known CHECK (platform IN ('bilibili', 'douyin', 'zhihu'));
