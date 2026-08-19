CREATE TABLE IF NOT EXISTS page_change_sources (
  id uuid PRIMARY KEY,
  name varchar(128) NOT NULL,
  target_url varchar(2048) NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  interval_minutes integer,
  confirm_delay_seconds integer NOT NULL DEFAULT 300,
  content_selector varchar(512),
  ignore_selectors jsonb NOT NULL DEFAULT '[]'::jsonb,
  etag varchar(512),
  last_modified varchar(512),
  baseline_fingerprint char(64),
  baseline_content text,
  baseline_observed_at timestamptz,
  pending_fingerprint char(64),
  pending_content text,
  pending_first_observed_at timestamptz,
  pending_confirm_after timestamptz,
  next_check_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code varchar(64),
  last_error_summary varchar(500),
  consecutive_failures integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT page_change_interval_range
    CHECK (interval_minutes IS NULL OR interval_minutes BETWEEN 15 AND 525600),
  CONSTRAINT page_change_confirm_delay_range
    CHECK (confirm_delay_seconds BETWEEN 60 AND 86400),
  CONSTRAINT page_change_failures_nonnegative CHECK (consecutive_failures >= 0),
  CONSTRAINT page_change_ignore_selectors_array
    CHECK (jsonb_typeof(ignore_selectors) = 'array'),
  CONSTRAINT page_change_baseline_pair
    CHECK ((baseline_fingerprint IS NULL) = (baseline_content IS NULL)),
  CONSTRAINT page_change_pending_pair
    CHECK ((pending_fingerprint IS NULL) = (pending_content IS NULL)),
  CONSTRAINT page_change_baseline_size
    CHECK (baseline_content IS NULL OR octet_length(baseline_content) <= 524288),
  CONSTRAINT page_change_pending_size
    CHECK (pending_content IS NULL OR octet_length(pending_content) <= 524288)
);

CREATE UNIQUE INDEX IF NOT EXISTS page_change_sources_active_name_unique
  ON page_change_sources (lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS page_change_sources_due_idx
  ON page_change_sources (next_check_at)
  WHERE deleted_at IS NULL AND enabled = true AND next_check_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS page_change_events (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES page_change_sources(id),
  guid varchar(160) NOT NULL UNIQUE,
  before_fingerprint char(64),
  after_fingerprint char(64) NOT NULL,
  title varchar(300) NOT NULL,
  content text NOT NULL,
  diff text,
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT page_change_event_content_not_empty CHECK (length(content) > 0),
  CONSTRAINT page_change_event_content_size CHECK (octet_length(content) <= 524288),
  CONSTRAINT page_change_event_diff_size CHECK (diff IS NULL OR octet_length(diff) <= 65536)
);

CREATE INDEX IF NOT EXISTS page_change_events_feed_idx
  ON page_change_events (source_id, published_at DESC, id DESC);

CREATE OR REPLACE FUNCTION prevent_page_change_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'page_change_events is immutable';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'page_change_events_immutable'
  ) THEN
    CREATE TRIGGER page_change_events_immutable
      BEFORE UPDATE OR DELETE ON page_change_events
      FOR EACH ROW EXECUTE FUNCTION prevent_page_change_event_mutation();
  END IF;
END;
$$;
