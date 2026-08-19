import type {
  SourceAuditEvent,
  SourceAuditVerification,
  SourceRouteInstance,
} from "@follow/feed-source-contracts"

import type { AuditEventDraft } from "./audit"
import { auditEventHash, auditHashesMatch } from "./audit"
import type { StoredCredential, SupplierRepository } from "./repository"
import { RepositoryConflictError } from "./repository"

const cloneCredential = (record: StoredCredential): StoredCredential => ({
  ...record,
  authenticationTag: Buffer.from(record.authenticationTag),
  ciphertext: Buffer.from(record.ciphertext),
  initializationVector: Buffer.from(record.initializationVector),
})

const cloneRoute = (route: SourceRouteInstance): SourceRouteInstance => ({
  ...route,
  secretQueryBindings: { ...route.secretQueryBindings },
})

export class MemorySupplierRepository implements SupplierRepository {
  private readonly auditEvents: SourceAuditEvent[] = []
  private readonly credentials = new Map<string, StoredCredential>()
  private readonly routes = new Map<string, SourceRouteInstance>()

  constructor(private readonly auditKey: Buffer) {}

  async initialize(): Promise<void> {}

  async close(): Promise<void> {}

  async isReady(): Promise<boolean> {
    return true
  }

  async countManagedRoutes(): Promise<number> {
    return [...this.routes.values()].filter((route) => !route.deletedAt).length
  }

  async listCredentials(): Promise<StoredCredential[]> {
    return [...this.credentials.values()].map(cloneCredential)
  }

  async findCredential(id: string): Promise<StoredCredential | null> {
    const record = this.credentials.get(id)
    return record ? cloneCredential(record) : null
  }

  async createCredential(
    record: StoredCredential,
    audit: AuditEventDraft,
  ): Promise<StoredCredential> {
    this.assertUniqueCredentialName(record.name, record.id)
    this.credentials.set(record.id, cloneCredential(record))
    this.appendAudit(audit)
    return cloneCredential(record)
  }

  async updateCredential(
    record: StoredCredential,
    audit: AuditEventDraft,
  ): Promise<StoredCredential | null> {
    if (!this.credentials.has(record.id)) return null
    this.assertUniqueCredentialName(record.name, record.id)
    this.credentials.set(record.id, cloneCredential(record))
    this.appendAudit(audit)
    return cloneCredential(record)
  }

  async disableCredential(
    id: string,
    disabledAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredCredential | null> {
    const record = this.credentials.get(id)
    if (!record || record.disabledAt) return null
    const inUse = [...this.routes.values()].some(
      (route) =>
        !route.deletedAt && route.enabled && Object.values(route.secretQueryBindings).includes(id),
    )
    if (inUse) throw new RepositoryConflictError("Credential is used by an enabled route")
    const updated = { ...record, disabledAt, updatedAt: disabledAt }
    this.credentials.set(id, cloneCredential(updated))
    this.appendAudit(audit)
    return cloneCredential(updated)
  }

  async rotateCredentials(records: StoredCredential[], audit: AuditEventDraft): Promise<number> {
    for (const record of records) this.credentials.set(record.id, cloneCredential(record))
    this.appendAudit(audit)
    return records.length
  }

  async recordAudit(audit: AuditEventDraft): Promise<void> {
    this.appendAudit(audit)
  }

  async listRoutes(): Promise<SourceRouteInstance[]> {
    return [...this.routes.values()].filter((route) => !route.deletedAt).map(cloneRoute)
  }

  async findRouteById(id: string): Promise<SourceRouteInstance | null> {
    const route = this.routes.get(id)
    return route && !route.deletedAt ? cloneRoute(route) : null
  }

  async findRouteBySourceURL(sourceURL: string): Promise<SourceRouteInstance | null> {
    const route = [...this.routes.values()].find(
      (item) => !item.deletedAt && item.sourceURL === sourceURL,
    )
    return route ? cloneRoute(route) : null
  }

  async createRoute(
    route: SourceRouteInstance,
    audit: AuditEventDraft,
  ): Promise<SourceRouteInstance> {
    this.assertUniqueRoute(route)
    this.routes.set(route.id, cloneRoute(route))
    this.appendAudit(audit)
    return cloneRoute(route)
  }

  async updateRoute(
    route: SourceRouteInstance,
    audit: AuditEventDraft,
  ): Promise<SourceRouteInstance | null> {
    if (!this.routes.has(route.id)) return null
    this.assertUniqueRoute(route)
    this.routes.set(route.id, cloneRoute(route))
    this.appendAudit(audit)
    return cloneRoute(route)
  }

  async softDeleteRoute(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<SourceRouteInstance | null> {
    const route = this.routes.get(id)
    if (!route || route.deletedAt) return null
    const updated = { ...route, deletedAt, enabled: false, updatedAt: deletedAt }
    this.routes.set(id, cloneRoute(updated))
    this.appendAudit(audit)
    return cloneRoute(updated)
  }

  async listAuditEvents(afterSequence: number, limit: number): Promise<SourceAuditEvent[]> {
    return this.auditEvents
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit)
      .map((event) => ({ ...event, details: { ...event.details } }))
  }

  async verifyAuditChain(): Promise<SourceAuditVerification> {
    let previousHash: string | null = null
    for (const event of this.auditEvents) {
      const expectedHash = auditEventHash(event, previousHash, this.auditKey)
      if (event.previousHash !== previousHash || !auditHashesMatch(event.eventHash, expectedHash)) {
        return {
          brokenAtSequence: event.sequence,
          checkedEvents: event.sequence - 1,
          valid: false,
        }
      }
      previousHash = event.eventHash
    }
    return { brokenAtSequence: null, checkedEvents: this.auditEvents.length, valid: true }
  }

  private appendAudit(draft: AuditEventDraft): void {
    const previousHash = this.auditEvents.at(-1)?.eventHash ?? null
    this.auditEvents.push({
      ...draft,
      eventHash: auditEventHash(draft, previousHash, this.auditKey),
      previousHash,
      sequence: this.auditEvents.length + 1,
    })
  }

  private assertUniqueCredentialName(name: string, id: string): void {
    const normalizedName = name.toLocaleLowerCase()
    const duplicate = [...this.credentials.values()].some(
      (record) =>
        record.id !== id &&
        !record.disabledAt &&
        record.name.toLocaleLowerCase() === normalizedName,
    )
    if (duplicate) throw new RepositoryConflictError("An active credential already uses this name")
  }

  private assertUniqueRoute(route: SourceRouteInstance): void {
    const normalizedName = route.name.toLocaleLowerCase()
    const duplicate = [...this.routes.values()].some(
      (item) =>
        item.id !== route.id &&
        !item.deletedAt &&
        (item.sourceURL === route.sourceURL || item.name.toLocaleLowerCase() === normalizedName),
    )
    if (duplicate)
      throw new RepositoryConflictError("An active route already uses this name or URL")
  }
}
