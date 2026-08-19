CREATE TABLE IF NOT EXISTS source_catalog_routes (
  id uuid PRIMARY KEY,
  route_key varchar(128) NOT NULL,
  title varchar(128) NOT NULL,
  description varchar(1000),
  category varchar(128) NOT NULL,
  documentation_url varchar(2048),
  route_path_template varchar(1024) NOT NULL,
  parameters jsonb NOT NULL DEFAULT '[]'::jsonb,
  secret_query_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT source_catalog_parameters_array CHECK (jsonb_typeof(parameters) = 'array'),
  CONSTRAINT source_catalog_bindings_object CHECK (jsonb_typeof(secret_query_bindings) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS source_catalog_routes_active_key_unique
  ON source_catalog_routes (lower(route_key))
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS source_catalog_routes_active_template_unique
  ON source_catalog_routes (route_path_template)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS source_catalog_routes_public_idx
  ON source_catalog_routes (category, lower(title))
  WHERE deleted_at IS NULL AND enabled = true;
