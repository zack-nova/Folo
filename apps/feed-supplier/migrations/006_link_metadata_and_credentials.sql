-- Reader-facing title and category of each public link, usually taken from the subscription preset.
ALTER TABLE public_feed_links ADD COLUMN IF NOT EXISTS title varchar(256);
ALTER TABLE public_feed_links ADD COLUMN IF NOT EXISTS category varchar(128);

-- RSSHub deployment credentials a catalog route uses (ADR-0033). NULL means undeclared, which the
-- credential overview reports as unknown; an empty array means the route uses none.
ALTER TABLE source_catalog_routes ADD COLUMN IF NOT EXISTS rsshub_credentials jsonb;
ALTER TABLE source_catalog_routes DROP CONSTRAINT IF EXISTS source_catalog_rsshub_credentials_array;
ALTER TABLE source_catalog_routes ADD CONSTRAINT source_catalog_rsshub_credentials_array
  CHECK (rsshub_credentials IS NULL OR jsonb_typeof(rsshub_credentials) = 'array');
