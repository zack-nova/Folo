import type { OfficialAcquisitionBinding } from "@follow/feed-source-contracts"

import type { AuditEventDraft } from "./audit"

/** Fields a binding attempt or read may change. */
export type OfficialBindingPatch = Partial<
  Pick<
    OfficialAcquisitionBinding,
    | "activatedAt"
    | "consecutiveFailureCount"
    | "externalFeedId"
    | "lastErrorCode"
    | "lastErrorSummary"
    | "lastSuccessAt"
    | "origin"
    | "status"
  >
>

export interface OfficialBindingRepository {
  /** Rejects with RepositoryConflictError when the address already has a live binding. */
  createOfficialBinding(
    binding: OfficialAcquisitionBinding,
    audit: AuditEventDraft,
  ): Promise<OfficialAcquisitionBinding>
  findOfficialBinding(id: string): Promise<OfficialAcquisitionBinding | null>
  /** The binding for this address that is not deleted, if any */
  findLiveOfficialBindingBySourceURL(sourceURL: string): Promise<OfficialAcquisitionBinding | null>
  /** Live bindings; deleted ones are history and are not listed */
  listOfficialBindings(): Promise<OfficialAcquisitionBinding[]>
  countOfficialBindings(): Promise<{ active: number; failed: number }>
  /** Null when the binding is deleted or missing. Audit is optional for read bookkeeping. */
  updateOfficialBinding(
    id: string,
    patch: OfficialBindingPatch,
    audit: AuditEventDraft | null,
  ): Promise<OfficialAcquisitionBinding | null>
  deleteOfficialBinding(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<OfficialAcquisitionBinding | null>
}
