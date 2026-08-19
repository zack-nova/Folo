import type {
  SourceAuditEvent,
  SourceAuditVerification,
  SourceCatalogRouteAdministration,
  SourceCredentialSummary,
  SourceRouteInstance,
} from "@follow/feed-source-contracts"

import type { AuditEventDraft } from "./audit"
import type { EncryptedCredentialValue } from "./credential-cipher"
import type { PageChangeRepository } from "./page-change-repository"

export interface StoredCredential extends SourceCredentialSummary, EncryptedCredentialValue {}

export class RepositoryConflictError extends Error {}

export interface SupplierRepository extends PageChangeRepository {
  close(): Promise<void>
  countManagedRoutes(): Promise<number>
  createCredential(record: StoredCredential, audit: AuditEventDraft): Promise<StoredCredential>
  createCatalogRoute(
    route: SourceCatalogRouteAdministration,
    audit: AuditEventDraft,
  ): Promise<SourceCatalogRouteAdministration>
  createRoute(route: SourceRouteInstance, audit: AuditEventDraft): Promise<SourceRouteInstance>
  disableCredential(
    id: string,
    disabledAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredCredential | null>
  findCredential(id: string): Promise<StoredCredential | null>
  findCatalogRouteById(id: string): Promise<SourceCatalogRouteAdministration | null>
  findRouteById(id: string): Promise<SourceRouteInstance | null>
  findRouteBySourceURL(sourceURL: string): Promise<SourceRouteInstance | null>
  initialize(): Promise<void>
  isReady(): Promise<boolean>
  listAuditEvents(afterSequence: number, limit: number): Promise<SourceAuditEvent[]>
  listCredentials(): Promise<StoredCredential[]>
  listCatalogRoutes(): Promise<SourceCatalogRouteAdministration[]>
  listRoutes(): Promise<SourceRouteInstance[]>
  recordAudit(audit: AuditEventDraft): Promise<void>
  rotateCredentials(records: StoredCredential[], audit: AuditEventDraft): Promise<number>
  softDeleteRoute(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<SourceRouteInstance | null>
  softDeleteCatalogRoute(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<SourceCatalogRouteAdministration | null>
  updateCredential(
    record: StoredCredential,
    audit: AuditEventDraft,
  ): Promise<StoredCredential | null>
  updateCatalogRoute(
    route: SourceCatalogRouteAdministration,
    audit: AuditEventDraft,
  ): Promise<SourceCatalogRouteAdministration | null>
  updateRoute(
    route: SourceRouteInstance,
    audit: AuditEventDraft,
  ): Promise<SourceRouteInstance | null>
  verifyAuditChain(): Promise<SourceAuditVerification>
}
