-- Official Folo account used to fetch selected sources (ADR-0034). The session token is kept
-- only encrypted under the credential keyring; at most one account is linked at a time.
CREATE TABLE IF NOT EXISTS official_accounts (
  id uuid PRIMARY KEY,
  status varchar(16) NOT NULL,
  external_user_id varchar(64) NOT NULL,
  role varchar(64),
  feed_subscription_limit integer,
  rsshub_subscription_limit integer,
  token_ciphertext bytea NOT NULL,
  token_initialization_vector bytea NOT NULL,
  token_authentication_tag bytea NOT NULL,
  token_key_id varchar(64) NOT NULL,
  linked_at timestamptz NOT NULL,
  last_verified_at timestamptz NOT NULL,
  session_expires_at timestamptz,
  auth_invalid_at timestamptz,
  unlinked_at timestamptz,
  CONSTRAINT official_accounts_status CHECK (status IN ('active', 'auth_invalid', 'unlinked')),
  CONSTRAINT official_accounts_unlinked CHECK ((status = 'unlinked') = (unlinked_at IS NOT NULL)),
  CONSTRAINT official_accounts_ciphertext_not_empty CHECK (octet_length(token_ciphertext) > 0),
  CONSTRAINT official_accounts_iv_length CHECK (octet_length(token_initialization_vector) = 12),
  CONSTRAINT official_accounts_tag_length CHECK (octet_length(token_authentication_tag) = 16)
);

CREATE UNIQUE INDEX IF NOT EXISTS official_accounts_single_linked
  ON official_accounts ((true))
  WHERE status <> 'unlinked';
