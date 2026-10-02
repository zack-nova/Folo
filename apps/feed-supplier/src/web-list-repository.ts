import type { WebListItem, WebListSource } from "@follow/feed-source-contracts"

import type { AuditEventDraft } from "./audit"

export interface StoredWebListSource extends WebListSource {
  etag: string | null
  lastModified: string | null
}
export interface StoredWebListItem extends WebListItem {
  itemKey: string
}
export interface WebListRepository {
  countWebListSources(now: string): Promise<{ due: number; enabled: number; total: number }>
  createWebListSource(
    source: StoredWebListSource,
    audit: AuditEventDraft,
  ): Promise<StoredWebListSource>
  updateWebListSource(
    source: StoredWebListSource,
    audit: AuditEventDraft,
  ): Promise<StoredWebListSource | null>
  softDeleteWebListSource(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredWebListSource | null>
  findWebListSource(id: string): Promise<StoredWebListSource | null>
  listWebListSources(): Promise<StoredWebListSource[]>
  listDueWebListSources(now: string, limit: number): Promise<StoredWebListSource[]>
  listWebListItems(sourceId: string, limit: number): Promise<StoredWebListItem[]>
  findWebListItemKeys(sourceId: string, keys: string[]): Promise<string[]>
  saveWebListObservation(
    source: StoredWebListSource,
    items: StoredWebListItem[],
  ): Promise<StoredWebListSource>
}
