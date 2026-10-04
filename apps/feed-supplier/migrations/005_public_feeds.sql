-- Public subscription channel (ADR-0033): one grant per consumer, one unguessable link per source.
CREATE TABLE IF NOT EXISTS public_feed_grants (
  id uuid PRIMARY KEY,
  name varchar(128) NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS public_feed_grants_active_name_unique
  ON public_feed_grants (lower(name))
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public_feed_links (
  id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES public_feed_grants (id),
  source_url varchar(2048) NOT NULL,
  -- SHA-256 of the token, used for lookup; the token itself is only kept encrypted for export.
  token_hash bytea NOT NULL,
  token_ciphertext bytea NOT NULL,
  token_initialization_vector bytea NOT NULL,
  token_authentication_tag bytea NOT NULL,
  token_key_id varchar(64) NOT NULL,
  created_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_access_at timestamptz,
  last_access_ip varchar(64),
  last_access_user_agent varchar(512),
  CONSTRAINT public_feed_links_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT public_feed_links_iv_length CHECK (octet_length(token_initialization_vector) = 12),
  CONSTRAINT public_feed_links_tag_length CHECK (octet_length(token_authentication_tag) = 16)
);

CREATE UNIQUE INDEX IF NOT EXISTS public_feed_links_token_hash_unique
  ON public_feed_links (token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS public_feed_links_active_source_unique
  ON public_feed_links (grant_id, source_url)
  WHERE revoked_at IS NULL;
