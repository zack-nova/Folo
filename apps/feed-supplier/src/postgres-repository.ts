import { readFile } from "node:fs/promises"

import type {
  OfficialAcquisitionBinding,
  PageChangeEvent,
  RssHubCredentialRequirement,
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
import type { EncryptedCredentialValue } from "./credential-cipher"
import type {
  OfficialAccountVerification,
  StoredOfficialAccount,
} from "./official-account-repository"
import type { OfficialBindingPatch } from "./official-binding-repository"
import type { PageChangeProviderCounts, StoredPageChangeSource } from "./page-change-repository"
import type {
  PublicFeedAccess,
  StoredPublicFeedGrant,
  StoredPublicFeedLink,
} from "./public-feed-repository"
import type { StoredCredential, SupplierRepository } from "./repository"
import { RepositoryConflictError } from "./repository"
import type { WebListSourceRow } from "./web-list-postgres"
import {
  webListItemColumns,
  webListItemFromRow,
  webListItemSelect,
  webListSourceColumns,
  webListSourceFromRow,
  webListSourceSelect,
  webListSourceValues,
} from "./web-list-postgres"
import type { StoredWebListItem, StoredWebListSource } from "./web-list-repository"

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
  rsshub_credentials: unknown
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

const parseRssHubCredentials = (value: unknown): RssHubCredentialRequirement[] | null => {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) throw new Error("Persisted RSSHub credentials are invalid")
  return value as RssHubCredentialRequirement[]
}

const catalogRouteFromRow = (row: CatalogRouteRow): SourceCatalogRouteAdministration => {
  const secretQueryBindings = parseBindings(row.secret_query_bindings)
  return {
    category: row.category,
    createdAt: isoTimestamp(row.created_at),
    deletedAt: optionalTimestamp(row.deleted_at),
    description: row.description,
    rssHubCredentials: parseRssHubCredentials(row.rsshub_credentials),
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

interface PublicFeedGrantRow {
  id: string
  name: string
  created_at: Date
  revoked_at: Date | null
}

interface PublicFeedLinkRow {
  id: string
  grant_id: string
  source_url: string
  title: string | null
  category: string | null
  token_hash: Buffer
  token_ciphertext: Buffer
  token_initialization_vector: Buffer
  token_authentication_tag: Buffer
  token_key_id: string
  created_at: Date
  rotated_at: Date | null
  revoked_at: Date | null
  last_access_at: Date | null
  last_access_ip: string | null
  last_access_user_agent: string | null
}

const publicFeedGrantFromRow = (row: PublicFeedGrantRow): StoredPublicFeedGrant => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
  revokedAt: row.revoked_at?.toISOString() ?? null,
})

const publicFeedLinkFromRow = (row: PublicFeedLinkRow): StoredPublicFeedLink => ({
  id: row.id,
  grantId: row.grant_id,
  sourceURL: row.source_url,
  title: row.title,
  category: row.category,
  tokenHash: row.token_hash,
  token: {
    authenticationTag: row.token_authentication_tag,
    ciphertext: row.token_ciphertext,
    initializationVector: row.token_initialization_vector,
    keyId: row.token_key_id,
  },
  createdAt: row.created_at.toISOString(),
  rotatedAt: row.rotated_at?.toISOString() ?? null,
  revokedAt: row.revoked_at?.toISOString() ?? null,
  lastAccess: row.last_access_at
    ? {
        at: row.last_access_at.toISOString(),
        ip: row.last_access_ip,
        userAgent: row.last_access_user_agent,
      }
    : null,
})

interface OfficialAccountRow {
  id: string
  status: StoredOfficialAccount["status"]
  external_user_id: string
  role: string | null
  feed_subscription_limit: number | null
  rsshub_subscription_limit: number | null
  token_ciphertext: Buffer
  token_initialization_vector: Buffer
  token_authentication_tag: Buffer
  token_key_id: string
  linked_at: Date
  last_verified_at: Date
  session_expires_at: Date | null
  auth_invalid_at: Date | null
  unlinked_at: Date | null
}

const officialAccountFromRow = (row: OfficialAccountRow): StoredOfficialAccount => ({
  id: row.id,
  status: row.status,
  externalUserId: row.external_user_id,
  role: row.role,
  feedSubscriptionLimit: row.feed_subscription_limit,
  rssHubSubscriptionLimit: row.rsshub_subscription_limit,
  token: {
    authenticationTag: row.token_authentication_tag,
    ciphertext: row.token_ciphertext,
    initializationVector: row.token_initialization_vector,
    keyId: row.token_key_id,
  },
  linkedAt: row.linked_at.toISOString(),
  lastVerifiedAt: row.last_verified_at.toISOString(),
  sessionExpiresAt: row.session_expires_at?.toISOString() ?? null,
  authInvalidAt: row.auth_invalid_at?.toISOString() ?? null,
  unlinkedAt: row.unlinked_at?.toISOString() ?? null,
})

interface OfficialBindingRow {
  id: string
  source_url: string
  account_id: string
  external_feed_id: string | null
  origin: OfficialAcquisitionBinding["origin"]
  status: OfficialAcquisitionBinding["status"]
  created_at: Date
  activated_at: Date | null
  deleted_at: Date | null
  last_error_code: string | null
  last_error_summary: string | null
  last_success_at: Date | null
  consecutive_failure_count: number
}

const officialBindingFromRow = (row: OfficialBindingRow): OfficialAcquisitionBinding => ({
  id: row.id,
  sourceURL: row.source_url,
  accountId: row.account_id,
  externalFeedId: row.external_feed_id,
  origin: row.origin,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  activatedAt: row.activated_at?.toISOString() ?? null,
  deletedAt: row.deleted_at?.toISOString() ?? null,
  lastErrorCode: row.last_error_code,
  lastErrorSummary: row.last_error_summary,
  lastSuccessAt: row.last_success_at?.toISOString() ?? null,
  consecutiveFailureCount: row.consecutive_failure_count,
})

const officialBindingColumns: Record<keyof OfficialBindingPatch, string> = {
  activatedAt: "activated_at",
  consecutiveFailureCount: "consecutive_failure_count",
  externalFeedId: "external_feed_id",
  lastErrorCode: "last_error_code",
  lastErrorSummary: "last_error_summary",
  lastSuccessAt: "last_success_at",
  origin: "origin",
  status: "status",
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
      [
        "001_source_registry.sql",
        "002_page_change_sources.sql",
        "003_source_catalog.sql",
        "004_web_list_sources.sql",
        "005_public_feeds.sql",
        "006_link_metadata_and_credentials.sql",
        "007_official_accounts.sql",
        "008_official_bindings.sql",
      ].map(async (filename, index) => ({
        sql: await readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8"),
        version: index + 1,
      })),
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

  async countWebListSources(now: string): Promise<{ due: number; enabled: number; total: number }> {
    const result = await this.pool.query<{ due: number; enabled: number; total: number }>(
      `select count(*) filter (where enabled and next_check_at <= $1)::integer as due, count(*) filter (where enabled)::integer as enabled, count(*)::integer as total from web_list_sources where deleted_at is null`,
      [now],
    )
    return result.rows[0]!
  }
  async listWebListSources(): Promise<StoredWebListSource[]> {
    const result = await this.pool.query<WebListSourceRow>(
      `${webListSourceSelect} where source.deleted_at is null order by lower(source.name), source.created_at`,
    )
    return result.rows.map(webListSourceFromRow)
  }
  async findWebListSource(id: string): Promise<StoredWebListSource | null> {
    const result = await this.pool.query<WebListSourceRow>(
      `${webListSourceSelect} where source.id = $1 and source.deleted_at is null`,
      [id],
    )
    return result.rows[0] ? webListSourceFromRow(result.rows[0]) : null
  }
  async listDueWebListSources(now: string, limit: number): Promise<StoredWebListSource[]> {
    const result = await this.pool.query<WebListSourceRow>(
      `${webListSourceSelect} where source.deleted_at is null and source.enabled and source.next_check_at <= $1 order by source.next_check_at limit $2`,
      [now, limit],
    )
    return result.rows.map(webListSourceFromRow)
  }
  async createWebListSource(
    source: StoredWebListSource,
    audit: AuditEventDraft,
  ): Promise<StoredWebListSource> {
    try {
      return await this.withMutation(audit, async (client) => {
        const values = webListSourceValues(source)
        await client.query(
          `insert into web_list_sources (${[...Object.values(webListSourceColumns), "extraction"].join(",")}) values (${values.map((_value, index) => `$${index + 1}`).join(",")})`,
          values,
        )
        return source
      })
    } catch (error) {
      if (isUniqueViolation(error))
        throw new RepositoryConflictError("An active web list source already uses this name")
      throw error
    }
  }
  async updateWebListSource(
    source: StoredWebListSource,
    audit: AuditEventDraft,
  ): Promise<StoredWebListSource | null> {
    try {
      return await this.withMutation(audit, async (client) => {
        const columns = [...Object.values(webListSourceColumns), "extraction"].slice(1)
        const result = await client.query(
          `update web_list_sources set ${columns.map((column, index) => `${column} = $${index + 2}`).join(",")} where id = $1 and deleted_at is null`,
          webListSourceValues(source),
        )
        return result.rowCount ? source : null
      })
    } catch (error) {
      if (isUniqueViolation(error))
        throw new RepositoryConflictError("An active web list source already uses this name")
      throw error
    }
  }
  async softDeleteWebListSource(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredWebListSource | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<WebListSourceRow>(
        `${webListSourceSelect} where source.id = $1 and source.deleted_at is null`,
        [id],
      )
      if (!result.rows[0]) return null
      await client.query(
        "update web_list_sources set enabled = false, next_check_at = null, deleted_at = $2, updated_at = $2 where id = $1",
        [id, deletedAt],
      )
      return {
        ...webListSourceFromRow(result.rows[0]),
        enabled: false,
        nextCheckAt: null,
        deletedAt,
        updatedAt: deletedAt,
      }
    })
  }
  async listWebListItems(sourceId: string, limit: number): Promise<StoredWebListItem[]> {
    const result = await this.pool.query<StoredWebListItem>(
      `${webListItemSelect} where source_id = $1 order by coalesce(published_at, discovered_at) desc, discovered_at desc, id desc limit $2`,
      [sourceId, limit],
    )
    return result.rows.map(webListItemFromRow)
  }
  async findWebListItemKeys(sourceId: string, keys: string[]): Promise<string[]> {
    const result = await this.pool.query<{ item_key: string }>(
      "select item_key from web_list_items where source_id = $1 and item_key = ANY($2::text[])",
      [sourceId, keys],
    )
    return result.rows.map((row) => row.item_key)
  }
  async saveWebListObservation(
    source: StoredWebListSource,
    items: StoredWebListItem[],
  ): Promise<StoredWebListSource> {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `update web_list_sources set etag=$2, last_modified=$3, next_check_at=$4, last_attempt_at=$5, last_success_at=$6, last_error_code=$7, last_error_summary=$8, consecutive_failures=$9, updated_at=$10 where id=$1 and deleted_at is null`,
        [
          source.id,
          source.etag,
          source.lastModified,
          source.nextCheckAt,
          source.lastAttemptAt,
          source.lastSuccessAt,
          source.lastErrorCode,
          source.lastErrorSummary,
          source.consecutiveFailures,
          source.updatedAt,
        ],
      )
      if (!result.rowCount) throw new Error("Web list source was not found")
      for (const item of items) {
        const values = Object.keys(webListItemColumns).map(
          (key) => item[key as keyof typeof webListItemColumns],
        )
        await client.query(
          `insert into web_list_items (${Object.values(webListItemColumns).join(",")}) values (${values.map((_value, index) => `$${index + 1}`).join(",")}) on conflict (source_id, item_key) do nothing`,
          values,
        )
      }
      const saved = await client.query<WebListSourceRow>(
        `${webListSourceSelect} where source.id = $1`,
        [source.id],
      )
      return webListSourceFromRow(saved.rows[0]!)
    })
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
             created_at, updated_at, rsshub_credentials)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14::jsonb)
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
             updated_at = $13, rsshub_credentials = $14::jsonb
           -- $12 (created_at) never changes; PostgreSQL still needs a type for every parameter.
           where id = $1 and deleted_at is null and $12::timestamptz is not null returning *`,
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

  async findLinkedOfficialAccount(): Promise<StoredOfficialAccount | null> {
    const result = await this.pool.query<OfficialAccountRow>(
      "select * from official_accounts where status <> 'unlinked'",
    )
    return result.rows[0] ? officialAccountFromRow(result.rows[0]) : null
  }

  async linkOfficialAccount(
    account: StoredOfficialAccount,
    audit: AuditEventDraft,
  ): Promise<StoredOfficialAccount> {
    return this.withMutation(audit, async (client) => {
      await client.query(
        "update official_accounts set status = 'unlinked', unlinked_at = $1 where status <> 'unlinked'",
        [account.linkedAt],
      )
      await client.query(
        `insert into official_accounts
          (id, status, external_user_id, role, feed_subscription_limit, rsshub_subscription_limit,
           token_ciphertext, token_initialization_vector, token_authentication_tag, token_key_id,
           linked_at, last_verified_at, session_expires_at, auth_invalid_at, unlinked_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          account.id,
          account.status,
          account.externalUserId,
          account.role,
          account.feedSubscriptionLimit,
          account.rssHubSubscriptionLimit,
          account.token.ciphertext,
          account.token.initializationVector,
          account.token.authenticationTag,
          account.token.keyId,
          account.linkedAt,
          account.lastVerifiedAt,
          account.sessionExpiresAt,
          account.authInvalidAt,
          account.unlinkedAt,
        ],
      )
      return account
    })
  }

  async recordOfficialAccountVerification(
    id: string,
    verification: OfficialAccountVerification,
    audit: AuditEventDraft,
  ): Promise<StoredOfficialAccount | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<OfficialAccountRow>(
        `update official_accounts
           set role = $2, feed_subscription_limit = $3, rsshub_subscription_limit = $4,
               last_verified_at = $5, session_expires_at = $6
         where id = $1 and status = 'active'
         returning *`,
        [
          id,
          verification.role,
          verification.feedSubscriptionLimit,
          verification.rssHubSubscriptionLimit,
          verification.lastVerifiedAt,
          verification.sessionExpiresAt,
        ],
      )
      return result.rows[0] ? officialAccountFromRow(result.rows[0]) : null
    })
  }

  async markOfficialAccountAuthInvalid(
    id: string,
    at: string,
    audit: AuditEventDraft,
  ): Promise<StoredOfficialAccount | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<OfficialAccountRow>(
        `update official_accounts set status = 'auth_invalid', auth_invalid_at = $2
         where id = $1 and status = 'active' returning *`,
        [id, at],
      )
      return result.rows[0] ? officialAccountFromRow(result.rows[0]) : null
    })
  }

  async unlinkOfficialAccount(
    id: string,
    at: string,
    audit: AuditEventDraft,
  ): Promise<StoredOfficialAccount | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<OfficialAccountRow>(
        `update official_accounts set status = 'unlinked', unlinked_at = $2
         where id = $1 and status <> 'unlinked' returning *`,
        [id, at],
      )
      return result.rows[0] ? officialAccountFromRow(result.rows[0]) : null
    })
  }

  async reencryptOfficialAccountToken(
    id: string,
    token: EncryptedCredentialValue,
    audit: AuditEventDraft,
  ): Promise<boolean> {
    const updated = await this.withMutation(audit, async (client) => {
      const result = await client.query(
        `update official_accounts
           set token_ciphertext = $2, token_initialization_vector = $3,
               token_authentication_tag = $4, token_key_id = $5
         where id = $1 and status <> 'unlinked'`,
        [id, token.ciphertext, token.initializationVector, token.authenticationTag, token.keyId],
      )
      return result.rowCount ? true : null
    })
    return updated === true
  }

  async createOfficialBinding(
    binding: OfficialAcquisitionBinding,
    audit: AuditEventDraft,
  ): Promise<OfficialAcquisitionBinding> {
    try {
      return await this.withMutation(audit, async (client) => {
        await client.query(
          `insert into official_acquisition_bindings
            (id, source_url, account_id, external_feed_id, origin, status, created_at, activated_at,
             deleted_at, last_error_code, last_error_summary, last_success_at, consecutive_failure_count)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            binding.id,
            binding.sourceURL,
            binding.accountId,
            binding.externalFeedId,
            binding.origin,
            binding.status,
            binding.createdAt,
            binding.activatedAt,
            binding.deletedAt,
            binding.lastErrorCode,
            binding.lastErrorSummary,
            binding.lastSuccessAt,
            binding.consecutiveFailureCount,
          ],
        )
        return binding
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepositoryConflictError("This source already has an official binding")
      }
      throw error
    }
  }

  async findOfficialBinding(id: string): Promise<OfficialAcquisitionBinding | null> {
    const result = await this.pool.query<OfficialBindingRow>(
      "select * from official_acquisition_bindings where id = $1",
      [id],
    )
    return result.rows[0] ? officialBindingFromRow(result.rows[0]) : null
  }

  async findLiveOfficialBindingBySourceURL(
    sourceURL: string,
  ): Promise<OfficialAcquisitionBinding | null> {
    const result = await this.pool.query<OfficialBindingRow>(
      "select * from official_acquisition_bindings where source_url = $1 and status <> 'deleted'",
      [sourceURL],
    )
    return result.rows[0] ? officialBindingFromRow(result.rows[0]) : null
  }

  async listOfficialBindings(): Promise<OfficialAcquisitionBinding[]> {
    const result = await this.pool.query<OfficialBindingRow>(
      "select * from official_acquisition_bindings where status <> 'deleted' order by created_at, id",
    )
    return result.rows.map(officialBindingFromRow)
  }

  async countOfficialBindings(): Promise<{ active: number; failed: number }> {
    const result = await this.pool.query<{ active: string; failed: string }>(
      `select count(*) filter (where status = 'active') as active,
              count(*) filter (where status = 'failed') as failed
         from official_acquisition_bindings`,
    )
    return {
      active: Number(result.rows[0]?.active ?? 0),
      failed: Number(result.rows[0]?.failed ?? 0),
    }
  }

  async updateOfficialBinding(
    id: string,
    patch: OfficialBindingPatch,
    audit: AuditEventDraft | null,
  ): Promise<OfficialAcquisitionBinding | null> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return this.findOfficialBinding(id)
    const assignments = entries.map(
      ([key], index) =>
        `${officialBindingColumns[key as keyof OfficialBindingPatch]} = $${index + 2}`,
    )
    const run = async (client: PoolClient) => {
      const result = await client.query<OfficialBindingRow>(
        `update official_acquisition_bindings set ${assignments.join(", ")}
         where id = $1 and status <> 'deleted' returning *`,
        [id, ...entries.map(([, value]) => value)],
      )
      return result.rows[0] ? officialBindingFromRow(result.rows[0]) : null
    }
    return audit ? this.withMutation(audit, run) : this.withTransaction(run)
  }

  async deleteOfficialBinding(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<OfficialAcquisitionBinding | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<OfficialBindingRow>(
        `update official_acquisition_bindings set status = 'deleted', deleted_at = $2
         where id = $1 and status <> 'deleted' returning *`,
        [id, deletedAt],
      )
      return result.rows[0] ? officialBindingFromRow(result.rows[0]) : null
    })
  }

  async hasActivePublicFeedLinkForSource(sourceURL: string): Promise<boolean> {
    const result = await this.pool.query(
      `select 1 from public_feed_links link
        join public_feed_grants grant_record on grant_record.id = link.grant_id
        where link.source_url = $1 and link.revoked_at is null and grant_record.revoked_at is null
        limit 1`,
      [sourceURL],
    )
    return (result.rowCount ?? 0) > 0
  }

  async createPublicFeedGrant(
    grant: StoredPublicFeedGrant,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedGrant> {
    try {
      return await this.withMutation(audit, async (client) => {
        await client.query(
          "insert into public_feed_grants (id, name, created_at, revoked_at) values ($1, $2, $3, $4)",
          [grant.id, grant.name, grant.createdAt, grant.revokedAt],
        )
        return grant
      })
    } catch (error) {
      if (isUniqueViolation(error))
        throw new RepositoryConflictError("An active public feed grant already uses this name")
      throw error
    }
  }

  async findPublicFeedGrant(id: string): Promise<StoredPublicFeedGrant | null> {
    const result = await this.pool.query<PublicFeedGrantRow>(
      "select * from public_feed_grants where id = $1",
      [id],
    )
    return result.rows[0] ? publicFeedGrantFromRow(result.rows[0]) : null
  }

  async listPublicFeedGrants(): Promise<StoredPublicFeedGrant[]> {
    const result = await this.pool.query<PublicFeedGrantRow>(
      "select * from public_feed_grants order by created_at, id",
    )
    return result.rows.map(publicFeedGrantFromRow)
  }

  async revokePublicFeedGrant(
    id: string,
    revokedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedGrant | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<PublicFeedGrantRow>(
        "update public_feed_grants set revoked_at = $2 where id = $1 and revoked_at is null returning *",
        [id, revokedAt],
      )
      if (!result.rows[0]) return null
      await client.query(
        "update public_feed_links set revoked_at = $2 where grant_id = $1 and revoked_at is null",
        [id, revokedAt],
      )
      return publicFeedGrantFromRow(result.rows[0])
    })
  }

  async createPublicFeedLink(
    link: StoredPublicFeedLink,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null> {
    try {
      return await this.withMutation(audit, async (client) => {
        // Locking the grant orders this insert with a concurrent revocation of the grant.
        const grant = await client.query(
          "select 1 from public_feed_grants where id = $1 and revoked_at is null for update",
          [link.grantId],
        )
        if (grant.rowCount === 0) return null
        await client.query(
          `insert into public_feed_links (
            id, grant_id, source_url, token_hash, token_ciphertext, token_initialization_vector,
            token_authentication_tag, token_key_id, created_at, title, category
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            link.id,
            link.grantId,
            link.sourceURL,
            link.tokenHash,
            link.token.ciphertext,
            link.token.initializationVector,
            link.token.authenticationTag,
            link.token.keyId,
            link.createdAt,
            link.title,
            link.category,
          ],
        )
        return link
      })
    } catch (error) {
      if (isUniqueViolation(error))
        throw new RepositoryConflictError("This grant already has an active link for the source")
      throw error
    }
  }

  async findPublicFeedLink(id: string): Promise<StoredPublicFeedLink | null> {
    const result = await this.pool.query<PublicFeedLinkRow>(
      "select * from public_feed_links where id = $1",
      [id],
    )
    return result.rows[0] ? publicFeedLinkFromRow(result.rows[0]) : null
  }

  async listPublicFeedLinks(grantId: string): Promise<StoredPublicFeedLink[]> {
    const result = await this.pool.query<PublicFeedLinkRow>(
      "select * from public_feed_links where grant_id = $1 order by created_at, id",
      [grantId],
    )
    return result.rows.map(publicFeedLinkFromRow)
  }

  async rotatePublicFeedLink(
    id: string,
    replacement: Pick<StoredPublicFeedLink, "token" | "tokenHash">,
    rotatedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<PublicFeedLinkRow>(
        `update public_feed_links set
          token_hash = $2, token_ciphertext = $3, token_initialization_vector = $4,
          token_authentication_tag = $5, token_key_id = $6, rotated_at = $7
        where id = $1 and revoked_at is null
        returning *`,
        [
          id,
          replacement.tokenHash,
          replacement.token.ciphertext,
          replacement.token.initializationVector,
          replacement.token.authenticationTag,
          replacement.token.keyId,
          rotatedAt,
        ],
      )
      return result.rows[0] ? publicFeedLinkFromRow(result.rows[0]) : null
    })
  }

  async updatePublicFeedLinkMetadata(
    id: string,
    metadata: Pick<StoredPublicFeedLink, "category" | "title">,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<PublicFeedLinkRow>(
        `update public_feed_links set title = $2, category = $3
          where id = $1 and revoked_at is null returning *`,
        [id, metadata.title, metadata.category],
      )
      return result.rows[0] ? publicFeedLinkFromRow(result.rows[0]) : null
    })
  }

  async reencryptPublicFeedLinkTokens(
    updates: Array<Pick<StoredPublicFeedLink, "id" | "token" | "tokenHash">>,
    audit: AuditEventDraft,
  ): Promise<number> {
    if (updates.length === 0) return 0
    return this.withTransaction(async (client) => {
      let updated = 0
      for (const update of updates) {
        // Skips a link rotated since it was read, whose new token must keep its own ciphertext.
        const result = await client.query(
          `update public_feed_links set
            token_ciphertext = $2, token_initialization_vector = $3,
            token_authentication_tag = $4, token_key_id = $5
          where id = $1 and token_hash = $6`,
          [
            update.id,
            update.token.ciphertext,
            update.token.initializationVector,
            update.token.authenticationTag,
            update.token.keyId,
            update.tokenHash,
          ],
        )
        updated += result.rowCount ?? 0
      }
      if (updated > 0) await this.appendAudit(client, audit)
      return updated
    })
  }

  async revokePublicFeedLink(
    id: string,
    revokedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null> {
    return this.withMutation(audit, async (client) => {
      const result = await client.query<PublicFeedLinkRow>(
        "update public_feed_links set revoked_at = $2 where id = $1 and revoked_at is null returning *",
        [id, revokedAt],
      )
      return result.rows[0] ? publicFeedLinkFromRow(result.rows[0]) : null
    })
  }

  async findActivePublicFeedLinkByTokenHash(
    tokenHash: Buffer,
  ): Promise<StoredPublicFeedLink | null> {
    const result = await this.pool.query<PublicFeedLinkRow>(
      `select link.* from public_feed_links link
        join public_feed_grants grant_record on grant_record.id = link.grant_id
        where link.token_hash = $1 and link.revoked_at is null and grant_record.revoked_at is null`,
      [tokenHash],
    )
    return result.rows[0] ? publicFeedLinkFromRow(result.rows[0]) : null
  }

  async recordPublicFeedAccess(id: string, access: PublicFeedAccess): Promise<void> {
    await this.pool.query(
      `update public_feed_links
        set last_access_at = $2, last_access_ip = $3, last_access_user_agent = $4
        where id = $1`,
      [id, access.at, access.ip, access.userAgent],
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
      route.rssHubCredentials === null ? null : JSON.stringify(route.rssHubCredentials),
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
