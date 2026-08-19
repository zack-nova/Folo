import type {
  PageChangeEvent,
  SourceAuditEvent,
  SourceAuditVerification,
  SourceCatalogRouteAdministration,
  SourceRouteInstance,
} from "@follow/feed-source-contracts"

import type { AuditEventDraft } from "./audit"
import { auditEventHash, auditHashesMatch } from "./audit"
import type { PageChangeProviderCounts, StoredPageChangeSource } from "./page-change-repository"
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

const cloneCatalogRoute = (
  route: SourceCatalogRouteAdministration,
): SourceCatalogRouteAdministration => ({
  ...route,
  parameters: route.parameters.map((parameter) => ({
    ...parameter,
    options: parameter.options.map((option) => ({ ...option })),
  })),
  secretQueryBindings: { ...route.secretQueryBindings },
})

const clonePageSource = (source: StoredPageChangeSource): StoredPageChangeSource => ({
  ...source,
  ignoreSelectors: [...source.ignoreSelectors],
})

const clonePageEvent = (event: PageChangeEvent): PageChangeEvent => ({ ...event })

export class MemorySupplierRepository implements SupplierRepository {
  private readonly auditEvents: SourceAuditEvent[] = []
  private readonly catalogRoutes = new Map<string, SourceCatalogRouteAdministration>()
  private readonly credentials = new Map<string, StoredCredential>()
  private readonly pageEvents = new Map<string, PageChangeEvent[]>()
  private readonly pageSources = new Map<string, StoredPageChangeSource>()
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

  async countPageChangeSources(now: string): Promise<PageChangeProviderCounts> {
    const sources = [...this.pageSources.values()].filter((source) => !source.deletedAt)
    return {
      due: sources.filter(
        (source) => source.enabled && source.nextCheckAt && source.nextCheckAt <= now,
      ).length,
      enabled: sources.filter((source) => source.enabled).length,
      total: sources.length,
    }
  }

  async listPageChangeSources(): Promise<StoredPageChangeSource[]> {
    return [...this.pageSources.values()]
      .filter((source) => !source.deletedAt)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(clonePageSource)
  }

  async findPageChangeSource(id: string): Promise<StoredPageChangeSource | null> {
    const source = this.pageSources.get(id)
    return source && !source.deletedAt ? clonePageSource(source) : null
  }

  async createPageChangeSource(
    source: StoredPageChangeSource,
    audit: AuditEventDraft,
  ): Promise<StoredPageChangeSource> {
    this.assertUniquePageSourceName(source.name, source.id)
    this.pageSources.set(source.id, clonePageSource(source))
    this.appendAudit(audit)
    return clonePageSource(source)
  }

  async updatePageChangeSource(
    source: StoredPageChangeSource,
    audit: AuditEventDraft,
  ): Promise<StoredPageChangeSource | null> {
    const current = this.pageSources.get(source.id)
    if (!current || current.deletedAt) return null
    this.assertUniquePageSourceName(source.name, source.id)
    this.pageSources.set(source.id, clonePageSource(source))
    this.appendAudit(audit)
    return clonePageSource(source)
  }

  async softDeletePageChangeSource(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPageChangeSource | null> {
    const source = this.pageSources.get(id)
    if (!source || source.deletedAt) return null
    const updated = {
      ...source,
      deletedAt,
      enabled: false,
      nextCheckAt: null,
      updatedAt: deletedAt,
    }
    this.pageSources.set(id, clonePageSource(updated))
    this.appendAudit(audit)
    return clonePageSource(updated)
  }

  async listDuePageChangeSources(now: string, limit: number): Promise<StoredPageChangeSource[]> {
    return [...this.pageSources.values()]
      .filter(
        (source) =>
          !source.deletedAt && source.enabled && source.nextCheckAt && source.nextCheckAt <= now,
      )
      .sort((left, right) => left.nextCheckAt!.localeCompare(right.nextCheckAt!))
      .slice(0, limit)
      .map(clonePageSource)
  }

  async savePageChangeObservation(
    source: StoredPageChangeSource,
    event: PageChangeEvent | null,
  ): Promise<StoredPageChangeSource> {
    const current = this.pageSources.get(source.id)
    if (!current || current.deletedAt) throw new Error("Page change source was not found")
    const events = this.pageEvents.get(source.id) ?? []
    if (event) {
      if (events.some((candidate) => candidate.id === event.id || candidate.guid === event.guid)) {
        throw new RepositoryConflictError("Page change event already exists")
      }
      events.push(clonePageEvent(event))
      this.pageEvents.set(source.id, events)
    }
    const updated = { ...source, eventCount: source.eventCount + (event ? 1 : 0) }
    this.pageSources.set(source.id, clonePageSource(updated))
    return clonePageSource(updated)
  }

  async listPageChangeEvents(sourceId: string, limit: number): Promise<PageChangeEvent[]> {
    return [...(this.pageEvents.get(sourceId) ?? [])]
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
      .slice(0, limit)
      .map(clonePageEvent)
  }

  async listCredentials(): Promise<StoredCredential[]> {
    return [...this.credentials.values()].map(cloneCredential)
  }

  async listCatalogRoutes(): Promise<SourceCatalogRouteAdministration[]> {
    return [...this.catalogRoutes.values()]
      .filter((route) => !route.deletedAt)
      .sort((left, right) => left.title.localeCompare(right.title))
      .map(cloneCatalogRoute)
  }

  async findCatalogRouteById(id: string): Promise<SourceCatalogRouteAdministration | null> {
    const route = this.catalogRoutes.get(id)
    return route && !route.deletedAt ? cloneCatalogRoute(route) : null
  }

  async createCatalogRoute(
    route: SourceCatalogRouteAdministration,
    audit: AuditEventDraft,
  ): Promise<SourceCatalogRouteAdministration> {
    this.assertUniqueCatalogRoute(route)
    this.catalogRoutes.set(route.id, cloneCatalogRoute(route))
    this.appendAudit(audit)
    return cloneCatalogRoute(route)
  }

  async updateCatalogRoute(
    route: SourceCatalogRouteAdministration,
    audit: AuditEventDraft,
  ): Promise<SourceCatalogRouteAdministration | null> {
    if (!this.catalogRoutes.has(route.id)) return null
    this.assertUniqueCatalogRoute(route)
    this.catalogRoutes.set(route.id, cloneCatalogRoute(route))
    this.appendAudit(audit)
    return cloneCatalogRoute(route)
  }

  async softDeleteCatalogRoute(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<SourceCatalogRouteAdministration | null> {
    const route = this.catalogRoutes.get(id)
    if (!route || route.deletedAt) return null
    const updated = { ...route, deletedAt, enabled: false, updatedAt: deletedAt }
    this.catalogRoutes.set(id, cloneCatalogRoute(updated))
    this.appendAudit(audit)
    return cloneCatalogRoute(updated)
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
    const inUse = [...this.routes.values(), ...this.catalogRoutes.values()].some(
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

  private assertUniqueCatalogRoute(route: SourceCatalogRouteAdministration): void {
    const normalizedKey = route.key.toLocaleLowerCase()
    const duplicate = [...this.catalogRoutes.values()].some(
      (item) =>
        item.id !== route.id &&
        !item.deletedAt &&
        (item.key.toLocaleLowerCase() === normalizedKey ||
          item.routePathTemplate === route.routePathTemplate),
    )
    if (duplicate) {
      throw new RepositoryConflictError("An active catalog route already uses this key or template")
    }
  }

  private assertUniquePageSourceName(name: string, id: string): void {
    const normalizedName = name.toLocaleLowerCase()
    const duplicate = [...this.pageSources.values()].some(
      (source) =>
        source.id !== id && !source.deletedAt && source.name.toLocaleLowerCase() === normalizedName,
    )
    if (duplicate) {
      throw new RepositoryConflictError("An active page source already uses this name")
    }
  }
}
