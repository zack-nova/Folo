import { webListFeedURL } from "@follow/feed-source-contracts"

import type { StoredWebListItem, StoredWebListSource } from "./web-list-repository"

// JSON projection keeps SQL column names explicit and timestamps in ISO form.
export const webListSourceColumns = {
  id: "id",
  name: "name",
  targetURL: "target_url",
  format: "format",
  filters: "filters",
  detail: "detail",
  maxItems: "max_items",
  maxPages: "max_pages",
  timeZone: "time_zone",
  enabled: "enabled",
  intervalMinutes: "interval_minutes",
  etag: "etag",
  lastModified: "last_modified",
  nextCheckAt: "next_check_at",
  lastAttemptAt: "last_attempt_at",
  lastSuccessAt: "last_success_at",
  lastErrorCode: "last_error_code",
  lastErrorSummary: "last_error_summary",
  consecutiveFailures: "consecutive_failures",
  deletedAt: "deleted_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const
export const webListItemColumns = {
  id: "id",
  sourceId: "source_id",
  itemKey: "item_key",
  guid: "guid",
  url: "url",
  title: "title",
  summary: "summary",
  content: "content",
  publishedAt: "published_at",
  discoveredAt: "discovered_at",
  detailStatus: "detail_status",
} as const
export const webListSourceSelect = `select ${Object.entries(webListSourceColumns)
  .map(([key, column]) => `source.${column} as "${key}"`)
  .join(", ")},
  source.extraction, (select count(*)::integer from web_list_items item where item.source_id = source.id) as "itemCount" from web_list_sources source`
export const webListItemSelect = `select ${Object.entries(webListItemColumns)
  .map(([key, column]) => `${column} as "${key}"`)
  .join(", ")} from web_list_items`
export type WebListSourceRow = Omit<StoredWebListSource, "html" | "json" | "feedURL"> & {
  extraction: NonNullable<StoredWebListSource["html"] | StoredWebListSource["json"]>
}
const iso = (value: string | Date | null): string | null =>
  value === null ? null : new Date(value).toISOString()
export const webListSourceFromRow = (row: WebListSourceRow): StoredWebListSource => {
  const { extraction, ...source } = row
  return {
    ...source,
    html: row.format === "html" ? (extraction as StoredWebListSource["html"]) : null,
    // Sources stored before metadataPaths existed read as having none.
    json:
      row.format === "json"
        ? {
            ...(extraction as NonNullable<StoredWebListSource["json"]>),
            metadataPaths:
              (extraction as Partial<NonNullable<StoredWebListSource["json"]>>).metadataPaths ?? {},
          }
        : null,
    feedURL: webListFeedURL(row.id),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    deletedAt: iso(row.deletedAt),
    nextCheckAt: iso(row.nextCheckAt),
    lastAttemptAt: iso(row.lastAttemptAt),
    lastSuccessAt: iso(row.lastSuccessAt),
  }
}
export const webListItemFromRow = (row: StoredWebListItem): StoredWebListItem => ({
  ...row,
  publishedAt: iso(row.publishedAt),
  discoveredAt: iso(row.discoveredAt)!,
})
export const webListSourceValues = (source: StoredWebListSource): unknown[] => [
  ...Object.keys(webListSourceColumns).map((key) => {
    const value = source[key as keyof typeof webListSourceColumns]
    return typeof value === "object" && value !== null ? JSON.stringify(value) : value
  }),
  JSON.stringify(source.format === "html" ? source.html : source.json),
]
