-- Sources served through the owner's official Folo account (ADR-0034). The logical address
-- stays the key; at most one binding per address is not deleted.
CREATE TABLE IF NOT EXISTS official_acquisition_bindings (
  id uuid PRIMARY KEY,
  source_url varchar(2048) NOT NULL,
  account_id uuid NOT NULL REFERENCES official_accounts (id),
  external_feed_id varchar(64),
  origin varchar(16),
  status varchar(16) NOT NULL,
  created_at timestamptz NOT NULL,
  activated_at timestamptz,
  deleted_at timestamptz,
  last_error_code varchar(64),
  last_error_summary varchar(500),
  last_success_at timestamptz,
  consecutive_failure_count integer NOT NULL DEFAULT 0,
  CONSTRAINT official_bindings_status CHECK (status IN ('pending', 'active', 'failed', 'deleted')),
  CONSTRAINT official_bindings_origin CHECK (origin IS NULL OR origin IN ('adopted', 'created')),
  CONSTRAINT official_bindings_deleted CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CONSTRAINT official_bindings_active_feed CHECK (status <> 'active' OR external_feed_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS official_bindings_live_source_unique
  ON official_acquisition_bindings (source_url)
  WHERE status <> 'deleted';
