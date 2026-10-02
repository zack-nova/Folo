CREATE TABLE IF NOT EXISTS web_list_sources (
  id uuid PRIMARY KEY,
  name varchar(128) NOT NULL,
  target_url varchar(2048) NOT NULL,
  format varchar(8) NOT NULL,
  extraction jsonb NOT NULL,
  filters jsonb NOT NULL,
  detail jsonb NOT NULL,
  max_items integer NOT NULL DEFAULT 20,
  max_pages integer NOT NULL DEFAULT 1,
  time_zone varchar(64) NOT NULL DEFAULT 'UTC',
  enabled boolean NOT NULL DEFAULT false,
  interval_minutes integer,
  etag varchar(512),
  last_modified varchar(512),
  next_check_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code varchar(64),
  last_error_summary varchar(500),
  consecutive_failures integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT web_list_format_known CHECK (format IN ('html', 'json')),
  CONSTRAINT web_list_extraction_object CHECK (jsonb_typeof(extraction) = 'object'),
  CONSTRAINT web_list_filters_object CHECK (jsonb_typeof(filters) = 'object'),
  CONSTRAINT web_list_detail_object CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT web_list_max_items_range CHECK (max_items BETWEEN 1 AND 100),
  CONSTRAINT web_list_max_pages_range CHECK (max_pages BETWEEN 1 AND 10),
  CONSTRAINT web_list_interval_range
    CHECK (interval_minutes IS NULL OR interval_minutes BETWEEN 15 AND 525600),
  CONSTRAINT web_list_failures_nonnegative CHECK (consecutive_failures >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS web_list_sources_active_name_unique
  ON web_list_sources (lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS web_list_sources_due_idx
  ON web_list_sources (next_check_at)
  WHERE deleted_at IS NULL AND enabled = true AND next_check_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS web_list_items (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES web_list_sources(id),
  item_key char(64) NOT NULL,
  guid varchar(160) NOT NULL UNIQUE,
  url varchar(2048) NOT NULL,
  title varchar(300) NOT NULL,
  summary text,
  content text,
  published_at timestamptz,
  discovered_at timestamptz NOT NULL,
  detail_status varchar(16) NOT NULL,
  CONSTRAINT web_list_item_identity_unique UNIQUE (source_id, item_key),
  CONSTRAINT web_list_item_title_not_empty CHECK (length(title) > 0),
  CONSTRAINT web_list_item_detail_status_known
    CHECK (detail_status IN ('failed', 'fetched', 'skipped')),
  CONSTRAINT web_list_item_summary_size
    CHECK (summary IS NULL OR octet_length(summary) <= 4096),
  CONSTRAINT web_list_item_content_size
    CHECK (content IS NULL OR octet_length(content) <= 131072)
);

CREATE INDEX IF NOT EXISTS web_list_items_feed_idx
  ON web_list_items (source_id, (coalesce(published_at, discovered_at)) DESC, discovered_at DESC);

CREATE OR REPLACE FUNCTION prevent_web_list_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'web_list_items is immutable';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'web_list_items_immutable'
  ) THEN
    CREATE TRIGGER web_list_items_immutable
      BEFORE UPDATE OR DELETE ON web_list_items
      FOR EACH ROW EXECUTE FUNCTION prevent_web_list_item_mutation();
  END IF;
END;
$$;
