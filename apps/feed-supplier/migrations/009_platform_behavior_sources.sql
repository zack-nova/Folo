CREATE TABLE IF NOT EXISTS behavior_sources (
  id uuid PRIMARY KEY,
  name varchar(128) NOT NULL,
  platform varchar(32) NOT NULL,
  scope varchar(32) NOT NULL,
  account_id varchar(64) NOT NULL,
  credential_id uuid REFERENCES source_credentials(id),
  enabled boolean NOT NULL DEFAULT false,
  interval_minutes integer,
  baseline_at timestamptz,
  next_check_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code varchar(64),
  last_error_summary varchar(500),
  consecutive_failures integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT behavior_platform_known CHECK (platform IN ('bilibili')),
  CONSTRAINT behavior_scope_known CHECK (scope IN ('favorites', 'follows')),
  CONSTRAINT behavior_interval_range
    CHECK (interval_minutes IS NULL OR interval_minutes BETWEEN 60 AND 525600),
  CONSTRAINT behavior_failures_nonnegative CHECK (consecutive_failures >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS behavior_sources_active_name_unique
  ON behavior_sources (lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS behavior_sources_due_idx
  ON behavior_sources (next_check_at)
  WHERE deleted_at IS NULL AND enabled = true AND next_check_at IS NOT NULL;

-- Every platform object a source has seen, with the snapshot it was seen with. Objects seen in
-- the baseline, or older than it, are recorded without an entry.
CREATE TABLE IF NOT EXISTS behavior_objects (
  source_id uuid NOT NULL REFERENCES behavior_sources(id),
  object_key varchar(128) NOT NULL,
  occurred_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  entry_guid varchar(160),
  PRIMARY KEY (source_id, object_key),
  CONSTRAINT behavior_object_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE IF NOT EXISTS behavior_entries (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES behavior_sources(id),
  guid varchar(160) NOT NULL UNIQUE,
  title varchar(300) NOT NULL,
  url varchar(2048) NOT NULL,
  summary text NOT NULL,
  content text NOT NULL,
  image_url varchar(2048),
  occurred_at timestamptz NOT NULL,
  discovered_at timestamptz NOT NULL,
  CONSTRAINT behavior_entry_title_not_empty CHECK (length(title) > 0),
  CONSTRAINT behavior_entry_summary_size CHECK (octet_length(summary) <= 4096),
  CONSTRAINT behavior_entry_content_size CHECK (octet_length(content) <= 131072)
);

CREATE INDEX IF NOT EXISTS behavior_entries_feed_idx
  ON behavior_entries (source_id, occurred_at DESC, discovered_at DESC);

CREATE OR REPLACE FUNCTION prevent_behavior_entry_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'behavior_entries is immutable';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'behavior_entries_immutable'
  ) THEN
    CREATE TRIGGER behavior_entries_immutable
      BEFORE UPDATE OR DELETE ON behavior_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_behavior_entry_mutation();
  END IF;
END;
$$;
