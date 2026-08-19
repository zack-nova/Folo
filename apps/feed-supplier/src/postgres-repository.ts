import { readFile } from "node:fs/promises"

import type {
  SourceAuditAction,
  SourceAuditEvent,
  SourceAuditVerification,
  SourceRouteInstance,
} from "@follow/feed-source-contracts"
import type { PoolClient, QueryResultRow } from "pg"
import { Pool } from "pg"

import type { AuditDetails, AuditEventDraft } from "./audit"
import { auditEventHash, auditHashesMatch } from "./audit"
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
    const migration = await readFile(
      new URL("../migrations/001_source_registry.sql", import.meta.url),
      "utf8",
    )
    await this.withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock($1)", [1_931_505_202])
      await client.query(`
        create table if not exists feed_supplier_schema_migrations (
          version integer primary key,
          applied_at timestamptz not null default now()
        )
      `)
      const applied = await client.query<{ version: number }>(
        "select version from feed_supplier_schema_migrations where version = $1",
        [1],
      )
      if (applied.rowCount === 0) {
        await client.query(migration)
        await client.query("insert into feed_supplier_schema_migrations (version) values ($1)", [1])
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

  async listCredentials(): Promise<StoredCredential[]> {
    const result = await this.pool.query<CredentialRow>(
      "select * from source_credentials order by lower(name), created_at",
    )
    return result.rows.map(credentialFromRow)
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
}
