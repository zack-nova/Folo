import type { PageChangeEvent, PageChangeSource } from "@follow/feed-source-contracts"

import type { AuditEventDraft } from "./audit"

export interface StoredPageChangeSource extends PageChangeSource {
  baselineContent: string | null
  etag: string | null
  lastModified: string | null
  pendingContent: string | null
  pendingFirstObservedAt: string | null
}

export interface PageChangeProviderCounts {
  due: number
  enabled: number
  total: number
}

export interface PageChangeRepository {
  countPageChangeSources(now: string): Promise<PageChangeProviderCounts>
  createPageChangeSource(
    source: StoredPageChangeSource,
    audit: AuditEventDraft,
  ): Promise<StoredPageChangeSource>
  findPageChangeSource(id: string): Promise<StoredPageChangeSource | null>
  listDuePageChangeSources(now: string, limit: number): Promise<StoredPageChangeSource[]>
  listPageChangeEvents(sourceId: string, limit: number): Promise<PageChangeEvent[]>
  listPageChangeSources(): Promise<StoredPageChangeSource[]>
  savePageChangeObservation(
    source: StoredPageChangeSource,
    event: PageChangeEvent | null,
  ): Promise<StoredPageChangeSource>
  softDeletePageChangeSource(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPageChangeSource | null>
  updatePageChangeSource(
    source: StoredPageChangeSource,
    audit: AuditEventDraft,
  ): Promise<StoredPageChangeSource | null>
}
