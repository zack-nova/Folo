import type {
  SourceAuditEvent,
  SourceAuditVerification,
  SourceCredentialSummary,
  SourceRouteInstance,
} from "@follow/feed-source-contracts"

import type { AuditEventDraft } from "./audit"
import type { EncryptedCredentialValue } from "./credential-cipher"

export interface StoredCredential extends SourceCredentialSummary, EncryptedCredentialValue {}

export class RepositoryConflictError extends Error {}

export interface SupplierRepository {
  close(): Promise<void>
  countManagedRoutes(): Promise<number>
  createCredential(record: StoredCredential, audit: AuditEventDraft): Promise<StoredCredential>
  createRoute(route: SourceRouteInstance, audit: AuditEventDraft): Promise<SourceRouteInstance>
  disableCredential(
    id: string,
    disabledAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredCredential | null>
  findCredential(id: string): Promise<StoredCredential | null>
  findRouteById(id: string): Promise<SourceRouteInstance | null>
  findRouteBySourceURL(sourceURL: string): Promise<SourceRouteInstance | null>
  initialize(): Promise<void>
  isReady(): Promise<boolean>
  listAuditEvents(afterSequence: number, limit: number): Promise<SourceAuditEvent[]>
  listCredentials(): Promise<StoredCredential[]>
  listRoutes(): Promise<SourceRouteInstance[]>
  recordAudit(audit: AuditEventDraft): Promise<void>
  rotateCredentials(records: StoredCredential[], audit: AuditEventDraft): Promise<number>
  softDeleteRoute(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<SourceRouteInstance | null>
  updateCredential(
    record: StoredCredential,
    audit: AuditEventDraft,
  ): Promise<StoredCredential | null>
  updateRoute(
    route: SourceRouteInstance,
    audit: AuditEventDraft,
  ): Promise<SourceRouteInstance | null>
  verifyAuditChain(): Promise<SourceAuditVerification>
}
