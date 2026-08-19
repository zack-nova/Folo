import { readFile } from "node:fs/promises"

import type {
  PageChangeEvent,
  SourceAuditAction,
  SourceAuditEvent,
  SourceAuditVerification,
  SourceCatalogParameter,
  SourceCatalogRouteAdministration,
  SourceRouteInstance,
} from "@follow/feed-source-contracts"
import type { PoolClient, QueryResultRow } from "pg"
import { Pool } from "pg"

import type { AuditDetails, AuditEventDraft } from "./audit"
import { auditEventHash, auditHashesMatch } from "./audit"
import type { PageChangeProviderCounts, StoredPageChangeSource } from "./page-change-repository"
import type { StoredCredential, SupplierRepository } from "./repository"
import { RepositoryConflictError } from "./repository"

interface CredentialRow extends QueryResultRow {
  authentication_tag: Buffer
  ciphertext: Buffer
  created_at: Date | string
  description: string | null
  disabled_at: Date | string | null
  id: string
  initialization_vector: Buffer
  key_id: string
  name: string
  updated_at: Date | string
}

interface RouteRow extends QueryResultRow {
  created_at: Date | string
  deleted_at: Date | string | null
  enabled: boolean
  id: string
  name: string
  secret_query_bindings: unknown
  source_url: string
  updated_at: Date | string
}

interface CatalogRouteRow extends QueryResultRow {
  category: string
  created_at: Date | string
  deleted_at: Date | string | null
  description: string | null
  documentation_url: string | null
  enabled: boolean
  id: string
  parameters: unknown
  route_key: string
  route_path_template: string
  secret_query_bindings: unknown
  title: string
  updated_at: Date | string
}

interface AuditRow extends QueryResultRow {
  action: SourceAuditAction
  actor: string
  details: AuditDetails
  event_hash: string
  id: string
  occurred_at: Date | string
  previous_hash: string | null
  resource_id: string | null
  resource_type: SourceAuditEvent["resourceType"]
  sequence: string
}

interface PageSourceRow extends QueryResultRow {
  baseline_content: string | null
  baseline_fingerprint: string | null
  baseline_observed_at: Date | string | null
  confirm_delay_seconds: number
  consecutive_failures: number
  content_selector: string | null
  created_at: Date | string
  deleted_at: Date | string | null
  enabled: boolean
  etag: string | null
  event_count: number | string
  id: string
  ignore_selectors: unknown
  interval_minutes: number | null
  last_attempt_at: Date | string | null
  last_error_code: string | null
  last_error_summary: string | null
  last_modified: string | null
  last_success_at: Date | string | null
  name: string
  next_check_at: Date | string | null
  pending_confirm_after: Date | string | null
  pending_content: string | null
  pending_fingerprint: string | null
  pending_first_observed_at: Date | string | null
  target_url: string
  updated_at: Date | string
}

interface PageEventRow extends QueryResultRow {
  after_fingerprint: string
  before_fingerprint: string | null
  content: string
  diff: string | null
  guid: string
  id: string
  published_at: Date | string
  source_id: string
  title: string
}

const isoTimestamp = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()

const credentialFromRow = (row: CredentialRow): StoredCredential => ({
  authenticationTag: row.authentication_tag,
  ciphertext: row.ciphertext,
  createdAt: isoTimestamp(row.created_at),
  description: row.description,
  disabledAt: row.disabled_at ? isoTimestamp(row.disabled_at) : null,
  id: row.id,
  initializationVector: row.initialization_vector,
  keyId: row.key_id,
  name: row.name,
  updatedAt: isoTimestamp(row.updated_at),
})

const parseBindings = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted route bindings are invalid")
  }
  const bindings: Record<string, string> = {}
  for (const [key, credentialId] of Object.entries(value)) {
    if (typeof credentialId !== "string") throw new Error("Persisted route bindings are invalid")
    bindings[key] = credentialId
  }
  return bindings
}

const routeFromRow = (row: RouteRow): SourceRouteInstance => ({
  createdAt: isoTimestamp(row.created_at),
  deletedAt: row.deleted_at ? isoTimestamp(row.deleted_at) : null,
  enabled: row.enabled,
  id: row.id,
  name: row.name,
  secretQueryBindings: parseBindings(row.secret_query_bindings),
  sourceURL: row.source_url,
  updatedAt: isoTimestamp(row.updated_at),
})

const parseCatalogParameters = (value: unknown): SourceCatalogParameter[] => {
  if (!Array.isArray(value)) throw new Error("Persisted catalog parameters are invalid")
  return value as SourceCatalogParameter[]
}

const catalogRouteFromRow = (row: CatalogRouteRow): SourceCatalogRouteAdministration => {
  const secretQueryBindings = parseBindings(row.secret_query_bindings)
  return {
    category: row.category,
    createdAt: isoTimestamp(row.created_at),
    deletedAt: optionalTimestamp(row.deleted_at),
    description: row.description,
    documentationURL: row.documentation_url,
    enabled: row.enabled,
    id: row.id,
    key: row.route_key,
    parameters: parseCatalogParameters(row.parameters),
    requiresCredentials: Object.keys(secretQueryBindings).length > 0,
    routePathTemplate: row.route_path_template,
    secretQueryBindings,
    title: row.title,
    updatedAt: isoTimestamp(row.updated_at),
  }
}

const auditFromRow = (row: AuditRow): SourceAuditEvent => ({
  action: row.action,
  actor: row.actor,
  details: row.details,
  eventHash: row.event_hash.trim(),
  id: row.id,
  occurredAt: isoTimestamp(row.occurred_at),
  previousHash: row.previous_hash?.trim() ?? null,
  resourceId: row.resource_id,
  resourceType: row.resource_type,
  sequence: Number(row.sequence),
})

const optionalTimestamp = (value: Date | string | null): string | null =>
  value ? isoTimestamp(value) : null

const parseIgnoreSelectors = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((selector) => typeof selector !== "string")) {
    throw new Error("Persisted page ignore selectors are invalid")
  }
  return [...value]
}

const pageSourceFromRow = (row: PageSourceRow): StoredPageChangeSource => ({
  baselineContent: row.baseline_content,
  baselineFingerprint: row.baseline_fingerprint?.trim() ?? null,
  baselineObservedAt: optionalTimestamp(row.baseline_observed_at),
  confirmDelaySeconds: row.confirm_delay_seconds,
  consecutiveFailures: row.consecutive_failures,
  contentSelector: row.content_selector,
  createdAt: isoTimestamp(row.created_at),
  deletedAt: optionalTimestamp(row.deleted_at),
  enabled: row.enabled,
  etag: row.etag,
  eventCount: Number(row.event_count),
  feedURL: `pagechange://${row.id}`,
  id: row.id,
  ignoreSelectors: parseIgnoreSelectors(row.ignore_selectors),
  intervalMinutes: row.interval_minutes,
  lastAttemptAt: optionalTimestamp(row.last_attempt_at),
  lastErrorCode: row.last_error_code,
  lastErrorSummary: row.last_error_summary,
  lastModified: row.last_modified,
  lastSuccessAt: optionalTimestamp(row.last_success_at),
  name: row.name,
  nextCheckAt: optionalTimestamp(row.next_check_at),
  pendingConfirmAfter: optionalTimestamp(row.pending_confirm_after),
  pendingContent: row.pending_content,
  pendingFingerprint: row.pending_fingerprint?.trim() ?? null,
  pendingFirstObservedAt: optionalTimestamp(row.pending_first_observed_at),
  targetURL: row.target_url,
  updatedAt: isoTimestamp(row.updated_at),
})

const pageEventFromRow = (row: PageEventRow): PageChangeEvent => ({
  afterFingerprint: row.after_fingerprint.trim(),
  beforeFingerprint: row.before_fingerprint?.trim() ?? null,
  content: row.content,
  diff: row.diff,
  guid: row.guid,
  id: row.id,
  publishedAt: isoTimestamp(row.published_at),
  sourceId: row.source_id,
  title: row.title,
})

const pageSourceSelect = `select source.*,
  (select count(*) from page_change_events event where event.source_id = source.id)::text as event_count
  from page_change_sources source`

const isUniqueViolation = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === "23505")

export interface PostgresSupplierRepositoryOptions {
  auditKey: Buffer
  connectionString: string
  maxConnections: number
}

export class PostgresSupplierRepository implements SupplierRepository {
  private readonly auditKey: Buffer
  private readonly pool: Pool

  constructor(options: PostgresSupplierRepositoryOptions) {
    this.auditKey = options.auditKey
    this.pool = new Pool({
      allowExitOnIdle: true,
      connectionString: options.connectionString,
      max: options.maxConnections,
    })
  }

  async initialize(): Promise<void> {
    const migrations = await Promise.all(
      ["001_source_registry.sql", "002_page_change_sources.sql", "003_source_catalog.sql"].map(
        async (filename, index) => ({
          sql: await readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8"),
          version: index + 1,
        }),
      ),
    )
    await this.withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock($1)", [1_931_505_202])
      await client.query(`
        create table if not exists feed_supplier_schema_migrations (
          version integer primary key,
          applied_at timestamptz not null default now()
        )
      `)
      for (const migration of migrations) {
        const applied = await client.query<{ version: number }>(
          "select version from feed_supplier_schema_migrations where version = $1",
          [migration.version],
        )
        if (applied.rowCount === 0) {
          await client.query(migration.sql)
          await client.query("insert into feed_supplier_schema_migrations (version) values ($1)", [
            migration.version,
          ])
        }
      }
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async isReady(): Promise<boolean> {
    try {
      await this.pool.query("select 1")
      return true
    } catch {
      return false
    }
  }

  async countManagedRoutes(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "select count(*)::text as count from source_route_instances where deleted_at is null",
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  async countPageChangeSources(now: string): Promise<PageChangeProviderCounts> {
    const result = await this.pool.query<{ due: string; enabled: string; total: string }>(
      `select
         count(*) filter (where enabled = true and next_check_at <= $1)::text as due,
         count(*) filter (where enabled = true)::text as enabled,
         count(*)::text as total
       from page_change_sources where deleted_at is null`,
      [now],
    )
    return {
      due: Number(result.rows[0]?.due ?? 0),
      enabled: Number(result.rows[0]?.enabled ?? 0),
      total: Number(result.rows[0]?.total ?? 0),
    }
  }

  async listPageChangeSources(): Promise<StoredPageChangeSource[]> {
    const result = await this.pool.query<PageSourceRow>(
      `${pageSourceSelect} where source.deleted_at is null order by lower(source.name), source.created_at`,
    )
    return result.rows.map(pageSourceFromRow)
  }

  async findPageChangeSource(id: string): Promise<StoredPageChangeSource | null> {
    const result = await this.pool.query<PageSourceRow>(
      `${pageSourceSelect} where source.id = $1 and source.deleted_at is null limit 1`,
      [id],
    )
    return result.rows[0] ? pageSourceFromRow(result.rows[0]) : null
  }

  async createPageChangeSource(
    source: StoredPageChangeSource,
    audit: AuditEventDraft,
  ): Promise<StoredPageChangeSource> {
    try {
      return await this.withMutation(audit, async (client) => {
        const result = await client.query<PageSourceRow>(
          `insert into page_change_sources
            (id, name, target_url, enabled, interval_minutes, confirm_delay_seconds,
             content_selector, ignore_selectors, etag, last_modified, baseline_fingerprint,
             baseline_content, baseline_observed_at, pending_fingerprint, pending_content,
             pending_first_observed_at, pending_confirm_after, next_check_at, last_attempt_at,
             last_success_at, last_error_code, last_error_summary, consecutive_failures,
             deleted_at, created_at, updated_at)
           values (${Array.from({ length: 26 }, (_, index) => `$${index + 1}`).join(", ")})
           returning *`,
          this.pageSourceParameters(source),
        )
        return pageSourceFromRow({ ...result.rows[0]!, event_count: 0 })
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepositoryConflictError("An active page source already uses this name")
      }
      throw error
    }
  }

  async updatePageChangeSource(
    source: StoredPageChangeSource,
    audit: AuditEventDraft,
  ): Promise<StoredPageChangeSource | null> {
    try {
      return await this.withMutation(audit, async (client) => {
        const values = this.pageSourceParameters(source)
        const assignments = [
          "name",
          "target_url",
          "enabled",
          "interval_minutes",
          "confirm_delay_seconds",
          "content_selector",
          "ignore_selectors",
          "etag",
          "last_modified",
          "baseline_fingerprint",
          "baseline_content",
          "baseline_observed_at",
          "pending_fingerprint",
          "pending_content",
          "pending_first_observed_at",
          "pending_confirm_after",
          "next_check_at",
          "last_attempt_at",
          "last_success_at",
          "last_error_code",
          "last_error_summary",
          "consecutive_failures",
          "deleted_at",
          "created_at",
          "updated_at",
        ]
        const result = await client.query<PageSourceRow>(
          `update page_change_sources set ${assignments
            .map((column, index) => `${column} = $${index + 2}`)
            .join(", ")}
           where id = $1 and deleted_at is null returning *`,
          values,
        )
        return result.rows[0]
          ? pageSourceFromRow({ ...result.rows[0], event_count: source.eventCount })
          : null
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepositoryConflictError("An active page source already uses this name")
      }
      throw error
    }
  }

  async softDeletePageChangeSource(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPageChangeSource | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<PageSourceRow>(
        `update page_change_sources
         set enabled = false, next_check_at = null, deleted_at = $2, updated_at = $2
         where id = $1 and deleted_at is null returning *`,
        [id, deletedAt],
      )
      if (!result.rows[0]) return null
      const count = await client.query<{ count: string }>(
        "select count(*)::text as count from page_change_events where source_id = $1",
        [id],
      )
      return pageSourceFromRow({ ...result.rows[0], event_count: count.rows[0]?.count ?? 0 })
    })
  }

  async listDuePageChangeSources(now: string, limit: number): Promise<StoredPageChangeSource[]> {
    const result = await this.pool.query<PageSourceRow>(
      `${pageSourceSelect}
       where source.deleted_at is null and source.enabled = true
         and source.next_check_at is not null and source.next_check_at <= $1
       order by source.next_check_at asc limit $2`,
      [now, limit],
    )
    return result.rows.map(pageSourceFromRow)
  }

  async savePageChangeObservation(
    source: StoredPageChangeSource,
    event: PageChangeEvent | null,
  ): Promise<StoredPageChangeSource> {
    return this.withTransaction(async (client) => {
      const result = await client.query<PageSourceRow>(
        `update page_change_sources set
           etag = $2, last_modified = $3, baseline_fingerprint = $4,
           baseline_content = $5, baseline_observed_at = $6, pending_fingerprint = $7,
           pending_content = $8, pending_first_observed_at = $9, pending_confirm_after = $10,
           next_check_at = $11, last_attempt_at = $12, last_success_at = $13,
           last_error_code = $14, last_error_summary = $15, consecutive_failures = $16,
           updated_at = $17
         where id = $1 and deleted_at is null returning *`,
        [
          source.id,
          source.etag,
          source.lastModified,
          source.baselineFingerprint,
          source.baselineContent,
          source.baselineObservedAt,
          source.pendingFingerprint,
          source.pendingContent,
          source.pendingFirstObservedAt,
          source.pendingConfirmAfter,
          source.nextCheckAt,
          source.lastAttemptAt,
          source.lastSuccessAt,
          source.lastErrorCode,
          source.lastErrorSummary,
          source.consecutiveFailures,
          source.updatedAt,
        ],
      )
      if (!result.rows[0]) throw new Error("Page change source was not found")
      if (event) {
        await client.query(
          `insert into page_change_events
            (id, source_id, guid, before_fingerprint, after_fingerprint, title, content, diff,
             published_at, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [
            event.id,
            event.sourceId,
            event.guid,
            event.beforeFingerprint,
            event.afterFingerprint,
            event.title,
            event.content,
            event.diff,
            event.publishedAt,
          ],
        )
      }
      return pageSourceFromRow({
        ...result.rows[0],
        event_count: source.eventCount + (event ? 1 : 0),
      })
    })
  }

  async listPageChangeEvents(sourceId: string, limit: number): Promise<PageChangeEvent[]> {
    const result = await this.pool.query<PageEventRow>(
      `select * from page_change_events where source_id = $1
       order by published_at desc, id desc limit $2`,
      [sourceId, limit],
    )
    return result.rows.map(pageEventFromRow)
  }

  async listCredentials(): Promise<StoredCredential[]> {
    const result = await this.pool.query<CredentialRow>(
      "select * from source_credentials order by lower(name), created_at",
    )
    return result.rows.map(credentialFromRow)
  }

  async listCatalogRoutes(): Promise<SourceCatalogRouteAdministration[]> {
    const result = await this.pool.query<CatalogRouteRow>(
      `select * from source_catalog_routes
       where deleted_at is null order by lower(category), lower(title), created_at`,
    )
    return result.rows.map(catalogRouteFromRow)
  }

  async findCatalogRouteById(id: string): Promise<SourceCatalogRouteAdministration | null> {
    const result = await this.pool.query<CatalogRouteRow>(
      "select * from source_catalog_routes where id = $1 and deleted_at is null limit 1",
      [id],
    )
    return result.rows[0] ? catalogRouteFromRow(result.rows[0]) : null
  }

  async createCatalogRoute(
    route: SourceCatalogRouteAdministration,
    audit: AuditEventDraft,
  ): Promise<SourceCatalogRouteAdministration> {
    try {
      return await this.withMutation(audit, async (client) => {
        const result = await client.query<CatalogRouteRow>(
          `insert into source_catalog_routes
            (id, route_key, title, description, category, documentation_url,
             route_path_template, parameters, secret_query_bindings, enabled, deleted_at,
             created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)
           returning *`,
          this.catalogRouteParameters(route),
        )
        return catalogRouteFromRow(result.rows[0]!)
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepositoryConflictError(
          "An active catalog route already uses this key or template",
        )
      }
      throw error
    }
  }

  async updateCatalogRoute(
    route: SourceCatalogRouteAdministration,
    audit: AuditEventDraft,
  ): Promise<SourceCatalogRouteAdministration | null> {
    try {
      return await this.withMutation(audit, async (client) => {
        const result = await client.query<CatalogRouteRow>(
          `update source_catalog_routes set
             route_key = $2, title = $3, description = $4, category = $5,
             documentation_url = $6, route_path_template = $7, parameters = $8::jsonb,
             secret_query_bindings = $9::jsonb, enabled = $10, deleted_at = $11,
             updated_at = $13
           where id = $1 and deleted_at is null returning *`,
          this.catalogRouteParameters(route),
        )
        return result.rows[0] ? catalogRouteFromRow(result.rows[0]) : null
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepositoryConflictError(
          "An active catalog route already uses this key or template",
        )
      }
      throw error
    }
  }

  async softDeleteCatalogRoute(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<SourceCatalogRouteAdministration | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<CatalogRouteRow>(
        `update source_catalog_routes
         set enabled = false, deleted_at = $2, updated_at = $2
         where id = $1 and deleted_at is null returning *`,
        [id, deletedAt],
      )
      return result.rows[0] ? catalogRouteFromRow(result.rows[0]) : null
    })
  }

  async findCredential(id: string): Promise<StoredCredential | null> {
    const result = await this.pool.query<CredentialRow>(
      "select * from source_credentials where id = $1 limit 1",
      [id],
    )
    return result.rows[0] ? credentialFromRow(result.rows[0]) : null
  }

  async createCredential(
    record: StoredCredential,
    audit: AuditEventDraft,
  ): Promise<StoredCredential> {
    try {
      return await this.withMutation(audit, async (client) => {
        const result = await client.query<CredentialRow>(
          `insert into source_credentials
            (id, name, description, ciphertext, initialization_vector, authentication_tag,
             key_id, disabled_at, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           returning *`,
          this.credentialParameters(record),
        )
        return credentialFromRow(result.rows[0]!)
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepositoryConflictError("An active credential already uses this name")
      }
      throw error
    }
  }

  async updateCredential(
    record: StoredCredential,
    audit: AuditEventDraft,
  ): Promise<StoredCredential | null> {
    try {
      return await this.withMutation(audit, async (client) => {
        const result = await client.query<CredentialRow>(
          `update source_credentials set
             name = $2, description = $3, ciphertext = $4, initialization_vector = $5,
             authentication_tag = $6, key_id = $7, disabled_at = $8, updated_at = $10
           where id = $1 returning *`,
          this.credentialParameters(record),
        )
        return result.rows[0] ? credentialFromRow(result.rows[0]) : null
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepositoryConflictError("An active credential already uses this name")
      }
      throw error
    }
  }

  async disableCredential(
    id: string,
    disabledAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredCredential | null> {
    return this.withMutation(audit, async (client) => {
      const usage = await client.query<{ used: boolean }>(
        `select exists(
           select 1 from source_route_instances route,
             jsonb_each_text(route.secret_query_bindings) binding
           where route.deleted_at is null and route.enabled = true and binding.value = $1
           union all
           select 1 from source_catalog_routes route,
             jsonb_each_text(route.secret_query_bindings) binding
           where route.deleted_at is null and route.enabled = true and binding.value = $1
         ) as used`,
        [id],
      )
      if (usage.rows[0]?.used) {
        throw new RepositoryConflictError("Credential is used by an enabled route")
      }
      const result = await client.query<CredentialRow>(
        `update source_credentials
         set disabled_at = $2, updated_at = $2
         where id = $1 and disabled_at is null returning *`,
        [id, disabledAt],
      )
      return result.rows[0] ? credentialFromRow(result.rows[0]) : null
    })
  }

  async rotateCredentials(records: StoredCredential[], audit: AuditEventDraft): Promise<number> {
    return this.withMutation(audit, async (client) => {
      for (const record of records) {
        await client.query(
          `update source_credentials set ciphertext = $2, initialization_vector = $3,
             authentication_tag = $4, key_id = $5, updated_at = $6
           where id = $1 and disabled_at is null`,
          [
            record.id,
            record.ciphertext,
            record.initializationVector,
            record.authenticationTag,
            record.keyId,
            record.updatedAt,
          ],
        )
      }
      return records.length
    })
  }

  async recordAudit(audit: AuditEventDraft): Promise<void> {
    await this.withTransaction(async (client) => this.appendAudit(client, audit))
  }

  async listRoutes(): Promise<SourceRouteInstance[]> {
    const result = await this.pool.query<RouteRow>(
      "select * from source_route_instances where deleted_at is null order by lower(name), created_at",
    )
    return result.rows.map(routeFromRow)
  }

  async findRouteById(id: string): Promise<SourceRouteInstance | null> {
    const result = await this.pool.query<RouteRow>(
      "select * from source_route_instances where id = $1 and deleted_at is null limit 1",
      [id],
    )
    return result.rows[0] ? routeFromRow(result.rows[0]) : null
  }

  async findRouteBySourceURL(sourceURL: string): Promise<SourceRouteInstance | null> {
    const result = await this.pool.query<RouteRow>(
      `select * from source_route_instances
       where source_url = $1 and deleted_at is null limit 1`,
      [sourceURL],
    )
    return result.rows[0] ? routeFromRow(result.rows[0]) : null
  }

  async createRoute(
    route: SourceRouteInstance,
    audit: AuditEventDraft,
  ): Promise<SourceRouteInstance> {
    try {
      return await this.withMutation(audit, async (client) => {
        const result = await client.query<RouteRow>(
          `insert into source_route_instances
            (id, name, source_url, enabled, secret_query_bindings, deleted_at, created_at, updated_at)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) returning *`,
          this.routeParameters(route),
        )
        return routeFromRow(result.rows[0]!)
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepositoryConflictError("An active route already uses this name or URL")
      }
      throw error
    }
  }

  async updateRoute(
    route: SourceRouteInstance,
    audit: AuditEventDraft,
  ): Promise<SourceRouteInstance | null> {
    try {
      return await this.withMutation(audit, async (client) => {
        const result = await client.query<RouteRow>(
          `update source_route_instances set
             name = $2, source_url = $3, enabled = $4, secret_query_bindings = $5::jsonb,
             deleted_at = $6, updated_at = $8
           where id = $1 and deleted_at is null returning *`,
          this.routeParameters(route),
        )
        return result.rows[0] ? routeFromRow(result.rows[0]) : null
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepositoryConflictError("An active route already uses this name or URL")
      }
      throw error
    }
  }

  async softDeleteRoute(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<SourceRouteInstance | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<RouteRow>(
        `update source_route_instances
         set enabled = false, deleted_at = $2, updated_at = $2
         where id = $1 and deleted_at is null returning *`,
        [id, deletedAt],
      )
      return result.rows[0] ? routeFromRow(result.rows[0]) : null
    })
  }

  async listAuditEvents(afterSequence: number, limit: number): Promise<SourceAuditEvent[]> {
    const result = await this.pool.query<AuditRow>(
      `select * from source_audit_events
       where sequence > $1 order by sequence asc limit $2`,
      [afterSequence, limit],
    )
    return result.rows.map(auditFromRow)
  }

  async verifyAuditChain(): Promise<SourceAuditVerification> {
    const result = await this.pool.query<AuditRow>(
      "select * from source_audit_events order by sequence asc",
    )
    let previousHash: string | null = null
    let checkedEvents = 0
    for (const row of result.rows) {
      const event = auditFromRow(row)
      const expectedHash = auditEventHash(event, previousHash, this.auditKey)
      if (event.previousHash !== previousHash || !auditHashesMatch(event.eventHash, expectedHash)) {
        return { brokenAtSequence: event.sequence, checkedEvents, valid: false }
      }
      checkedEvents += 1
      previousHash = event.eventHash
    }
    return { brokenAtSequence: null, checkedEvents, valid: true }
  }

  private async appendAudit(client: PoolClient, draft: AuditEventDraft): Promise<void> {
    await client.query("select pg_advisory_xact_lock($1)", [1_931_505_203])
    const previous = await client.query<{ event_hash: string }>(
      "select event_hash from source_audit_events order by sequence desc limit 1",
    )
    const previousHash = previous.rows[0]?.event_hash.trim() ?? null
    const eventHash = auditEventHash(draft, previousHash, this.auditKey)
    await client.query(
      `insert into source_audit_events
        (id, occurred_at, actor, action, resource_type, resource_id, details, previous_hash, event_hash)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [
        draft.id,
        draft.occurredAt,
        draft.actor,
        draft.action,
        draft.resourceType,
        draft.resourceId,
        JSON.stringify(draft.details),
        previousHash,
        eventHash,
      ],
    )
  }

  private async withMutation<T>(
    audit: AuditEventDraft,
    mutation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.withTransaction(async (client) => {
      const result = await mutation(client)
      if (result !== null) await this.appendAudit(client, audit)
      return result
    })
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("begin")
      const result = await operation(client)
      await client.query("commit")
      return result
    } catch (error) {
      await client.query("rollback")
      throw error
    } finally {
      client.release()
    }
  }

  private credentialParameters(record: StoredCredential): unknown[] {
    return [
      record.id,
      record.name,
      record.description,
      record.ciphertext,
      record.initializationVector,
      record.authenticationTag,
      record.keyId,
      record.disabledAt,
      record.createdAt,
      record.updatedAt,
    ]
  }

  private routeParameters(route: SourceRouteInstance): unknown[] {
    return [
      route.id,
      route.name,
      route.sourceURL,
      route.enabled,
      JSON.stringify(route.secretQueryBindings),
      route.deletedAt,
      route.createdAt,
      route.updatedAt,
    ]
  }

  private catalogRouteParameters(route: SourceCatalogRouteAdministration): unknown[] {
    return [
      route.id,
      route.key,
      route.title,
      route.description,
      route.category,
      route.documentationURL,
      route.routePathTemplate,
      JSON.stringify(route.parameters),
      JSON.stringify(route.secretQueryBindings),
      route.enabled,
      route.deletedAt,
      route.createdAt,
      route.updatedAt,
    ]
  }

  private pageSourceParameters(source: StoredPageChangeSource): unknown[] {
    return [
      source.id,
      source.name,
      source.targetURL,
      source.enabled,
      source.intervalMinutes,
      source.confirmDelaySeconds,
      source.contentSelector,
      JSON.stringify(source.ignoreSelectors),
      source.etag,
      source.lastModified,
      source.baselineFingerprint,
      source.baselineContent,
      source.baselineObservedAt,
      source.pendingFingerprint,
      source.pendingContent,
      source.pendingFirstObservedAt,
      source.pendingConfirmAfter,
      source.nextCheckAt,
      source.lastAttemptAt,
      source.lastSuccessAt,
      source.lastErrorCode,
      source.lastErrorSummary,
      source.consecutiveFailures,
      source.deletedAt,
      source.createdAt,
      source.updatedAt,
    ]
  }
}
