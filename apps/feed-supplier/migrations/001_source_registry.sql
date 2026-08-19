CREATE TABLE IF NOT EXISTS source_credentials (
  id uuid PRIMARY KEY,
  name varchar(128) NOT NULL,
  description varchar(500),
  ciphertext bytea NOT NULL,
  initialization_vector bytea NOT NULL,
  authentication_tag bytea NOT NULL,
  key_id varchar(64) NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT source_credentials_ciphertext_not_empty CHECK (octet_length(ciphertext) > 0),
  CONSTRAINT source_credentials_iv_length CHECK (octet_length(initialization_vector) = 12),
  CONSTRAINT source_credentials_tag_length CHECK (octet_length(authentication_tag) = 16)
);

CREATE UNIQUE INDEX IF NOT EXISTS source_credentials_active_name_unique
  ON source_credentials (lower(name))
  WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS source_route_instances (
  id uuid PRIMARY KEY,
  name varchar(128) NOT NULL,
  source_url varchar(2048) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  secret_query_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT source_route_bindings_object CHECK (jsonb_typeof(secret_query_bindings) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS source_route_instances_active_name_unique
  ON source_route_instances (lower(name))
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS source_route_instances_active_url_unique
  ON source_route_instances (source_url)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS source_audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  actor varchar(128) NOT NULL,
  action varchar(64) NOT NULL,
  resource_type varchar(32) NOT NULL,
  resource_id uuid,
  details jsonb NOT NULL,
  previous_hash char(64),
  event_hash char(64) NOT NULL,
  CONSTRAINT source_audit_details_object CHECK (jsonb_typeof(details) = 'object')
);

CREATE OR REPLACE FUNCTION prevent_source_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'source_audit_events is append-only';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'source_audit_events_append_only'
  ) THEN
    CREATE TRIGGER source_audit_events_append_only
      BEFORE UPDATE OR DELETE ON source_audit_events
      FOR EACH ROW EXECUTE FUNCTION prevent_source_audit_mutation();
  END IF;
END;
$$;
