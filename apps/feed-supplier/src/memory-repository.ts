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
import type {
  PublicFeedAccess,
  StoredPublicFeedGrant,
  StoredPublicFeedLink,
} from "./public-feed-repository"
import type { StoredCredential, SupplierRepository } from "./repository"
import { RepositoryConflictError } from "./repository"
import type { StoredWebListItem, StoredWebListSource } from "./web-list-repository"

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

// structuredClone turns a Buffer into a plain Uint8Array, so links are copied field by field.
const cloneLink = (link: StoredPublicFeedLink): StoredPublicFeedLink => ({
  ...link,
  tokenHash: Buffer.from(link.tokenHash),
  token: {
    authenticationTag: Buffer.from(link.token.authenticationTag),
    ciphertext: Buffer.from(link.token.ciphertext),
    initializationVector: Buffer.from(link.token.initializationVector),
    keyId: link.token.keyId,
  },
  lastAccess: link.lastAccess ? { ...link.lastAccess } : null,
})

export class MemorySupplierRepository implements SupplierRepository {
  private readonly publicFeedGrants = new Map<string, StoredPublicFeedGrant>()
  private readonly publicFeedLinks = new Map<string, StoredPublicFeedLink>()
  private readonly webListSources = new Map<string, StoredWebListSource>()
  private readonly webListItems = new Map<string, StoredWebListItem[]>()
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

  async countWebListSources(now: string): Promise<{ due: number; enabled: number; total: number }> {
    const sources = [...this.webListSources.values()].filter((source) => !source.deletedAt)
    return {
      due: sources.filter(
        (source) => source.enabled && source.nextCheckAt && source.nextCheckAt <= now,
      ).length,
      enabled: sources.filter((source) => source.enabled).length,
      total: sources.length,
    }
  }

  async listWebListSources(): Promise<StoredWebListSource[]> {
    return [...this.webListSources.values()]
      .filter((source) => !source.deletedAt)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((value) => structuredClone(value))
  }

  async findWebListSource(id: string): Promise<StoredWebListSource | null> {
    const source = this.webListSources.get(id)
    return source && !source.deletedAt ? structuredClone(source) : null
  }

  async createWebListSource(
    source: StoredWebListSource,
    audit: AuditEventDraft,
  ): Promise<StoredWebListSource> {
    this.assertUniqueWebListSourceName(source.name, source.id)
    this.webListSources.set(source.id, structuredClone(source))
    this.appendAudit(audit)
    return structuredClone(source)
  }

  async updateWebListSource(
    source: StoredWebListSource,
    audit: AuditEventDraft,
  ): Promise<StoredWebListSource | null> {
    const current = this.webListSources.get(source.id)
    if (!current || current.deletedAt) return null
    this.assertUniqueWebListSourceName(source.name, source.id)
    this.webListSources.set(source.id, structuredClone(source))
    this.appendAudit(audit)
    return structuredClone(source)
  }

  async softDeleteWebListSource(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredWebListSource | null> {
    const source = this.webListSources.get(id)
    if (!source || source.deletedAt) return null
    const updated = {
      ...source,
      deletedAt,
      enabled: false,
      nextCheckAt: null,
      updatedAt: deletedAt,
    }
    this.webListSources.set(id, structuredClone(updated))
    this.appendAudit(audit)
    return structuredClone(updated)
  }

  async listDueWebListSources(now: string, limit: number): Promise<StoredWebListSource[]> {
    return [...this.webListSources.values()]
      .filter(
        (source) =>
          !source.deletedAt && source.enabled && source.nextCheckAt && source.nextCheckAt <= now,
      )
      .sort((left, right) => left.nextCheckAt!.localeCompare(right.nextCheckAt!))
      .slice(0, limit)
      .map((value) => structuredClone(value))
  }

  async findWebListItemKeys(sourceId: string, keys: string[]): Promise<string[]> {
    return (this.webListItems.get(sourceId) ?? [])
      .filter((item) => keys.includes(item.itemKey))
      .map((item) => item.itemKey)
  }
  async saveWebListObservation(
    source: StoredWebListSource,
    items: StoredWebListItem[],
  ): Promise<StoredWebListSource> {
    const current = this.webListSources.get(source.id)
    if (!current || current.deletedAt) throw new Error("Web list source was not found")
    const stored = this.webListItems.get(source.id) ?? []
    for (const item of items) {
      if (!stored.some((existing) => existing.itemKey === item.itemKey))
        stored.push(structuredClone(item))
    }
    this.webListItems.set(source.id, stored)
    const updated = { ...source, itemCount: stored.length }
    this.webListSources.set(source.id, structuredClone(updated))
    return structuredClone(updated)
  }

  async listWebListItems(sourceId: string, limit: number): Promise<StoredWebListItem[]> {
    return [...(this.webListItems.get(sourceId) ?? [])]
      .sort(
        (left, right) =>
          (right.publishedAt ?? right.discoveredAt).localeCompare(
            left.publishedAt ?? left.discoveredAt,
          ) || right.discoveredAt.localeCompare(left.discoveredAt),
      )
      .slice(0, limit)
      .map((value) => structuredClone(value))
  }

  private assertUniqueWebListSourceName(name: string, id: string): void {
    if (
      [...this.webListSources.values()].some(
        (source) =>
          !source.deletedAt && source.id !== id && source.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new RepositoryConflictError("An active web list source already uses this name")
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

  async createPublicFeedGrant(
    grant: StoredPublicFeedGrant,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedGrant> {
    const normalizedName = grant.name.toLocaleLowerCase()
    if (
      [...this.publicFeedGrants.values()].some(
        (existing) => !existing.revokedAt && existing.name.toLocaleLowerCase() === normalizedName,
      )
    ) {
      throw new RepositoryConflictError("An active public feed grant already uses this name")
    }
    this.publicFeedGrants.set(grant.id, { ...grant })
    this.appendAudit(audit)
    return { ...grant }
  }

  async findPublicFeedGrant(id: string): Promise<StoredPublicFeedGrant | null> {
    const grant = this.publicFeedGrants.get(id)
    return grant ? { ...grant } : null
  }

  async listPublicFeedGrants(): Promise<StoredPublicFeedGrant[]> {
    return [...this.publicFeedGrants.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((grant) => ({ ...grant }))
  }

  async revokePublicFeedGrant(
    id: string,
    revokedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedGrant | null> {
    const grant = this.publicFeedGrants.get(id)
    if (!grant || grant.revokedAt) return null
    grant.revokedAt = revokedAt
    for (const link of this.publicFeedLinks.values()) {
      if (link.grantId === id && !link.revokedAt) link.revokedAt = revokedAt
    }
    this.appendAudit(audit)
    return { ...grant }
  }

  async createPublicFeedLink(
    link: StoredPublicFeedLink,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null> {
    const grant = this.publicFeedGrants.get(link.grantId)
    if (!grant || grant.revokedAt) return null
    if (
      [...this.publicFeedLinks.values()].some(
        (existing) =>
          !existing.revokedAt &&
          existing.grantId === link.grantId &&
          existing.sourceURL === link.sourceURL,
      )
    ) {
      throw new RepositoryConflictError("This grant already has an active link for the source")
    }
    this.publicFeedLinks.set(link.id, cloneLink(link))
    this.appendAudit(audit)
    return cloneLink(link)
  }

  async findPublicFeedLink(id: string): Promise<StoredPublicFeedLink | null> {
    const link = this.publicFeedLinks.get(id)
    return link ? cloneLink(link) : null
  }

  async listPublicFeedLinks(grantId: string): Promise<StoredPublicFeedLink[]> {
    return [...this.publicFeedLinks.values()]
      .filter((link) => link.grantId === grantId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(cloneLink)
  }

  async rotatePublicFeedLink(
    id: string,
    replacement: Pick<StoredPublicFeedLink, "token" | "tokenHash">,
    rotatedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null> {
    const link = this.publicFeedLinks.get(id)
    if (!link || link.revokedAt) return null
    const rotated = cloneLink({ ...link, ...replacement, rotatedAt })
    this.publicFeedLinks.set(id, rotated)
    this.appendAudit(audit)
    return cloneLink(rotated)
  }

  async updatePublicFeedLinkMetadata(
    id: string,
    metadata: Pick<StoredPublicFeedLink, "category" | "title">,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null> {
    const link = this.publicFeedLinks.get(id)
    if (!link || link.revokedAt) return null
    link.title = metadata.title
    link.category = metadata.category
    this.appendAudit(audit)
    return cloneLink(link)
  }

  async reencryptPublicFeedLinkTokens(
    updates: Array<Pick<StoredPublicFeedLink, "id" | "token">>,
    audit: AuditEventDraft,
  ): Promise<number> {
    if (updates.length === 0) return 0
    for (const update of updates) {
      const link = this.publicFeedLinks.get(update.id)
      if (link) this.publicFeedLinks.set(update.id, cloneLink({ ...link, token: update.token }))
    }
    this.appendAudit(audit)
    return updates.length
  }

  async revokePublicFeedLink(
    id: string,
    revokedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null> {
    const link = this.publicFeedLinks.get(id)
    if (!link || link.revokedAt) return null
    link.revokedAt = revokedAt
    this.appendAudit(audit)
    return cloneLink(link)
  }

  async findActivePublicFeedLinkByTokenHash(
    tokenHash: Buffer,
  ): Promise<StoredPublicFeedLink | null> {
    for (const link of this.publicFeedLinks.values()) {
      if (link.revokedAt || !link.tokenHash.equals(tokenHash)) continue
      return this.publicFeedGrants.get(link.grantId)?.revokedAt === null ? cloneLink(link) : null
    }
    return null
  }

  async recordPublicFeedAccess(id: string, access: PublicFeedAccess): Promise<void> {
    const link = this.publicFeedLinks.get(id)
    if (link) link.lastAccess = { ...access }
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
