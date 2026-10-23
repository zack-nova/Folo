import type { PlatformBehaviorEntry, PlatformBehaviorSource } from "@follow/feed-source-contracts"
import { behaviorFeedURL } from "@follow/feed-source-contracts"

import type { StoredBehaviorObject } from "./platform-behavior-repository"

// JSON projection keeps SQL column names explicit and timestamps in ISO form.
export const behaviorSourceColumns = {
  id: "id",
  name: "name",
  platform: "platform",
  scope: "scope",
  accountId: "account_id",
  credentialId: "credential_id",
  enabled: "enabled",
  intervalMinutes: "interval_minutes",
  baselineAt: "baseline_at",
  baselineCursor: "baseline_cursor",
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
export const behaviorObjectColumns = {
  sourceId: "source_id",
  objectKey: "object_key",
  occurredAt: "occurred_at",
  firstSeenAt: "first_seen_at",
  snapshot: "snapshot",
  entryGuid: "entry_guid",
} as const
export const behaviorEntryColumns = {
  id: "id",
  sourceId: "source_id",
  guid: "guid",
  title: "title",
  url: "url",
  summary: "summary",
  content: "content",
  imageURL: "image_url",
  occurredAt: "occurred_at",
  discoveredAt: "discovered_at",
} as const
export const behaviorSourceSelect = `select ${Object.entries(behaviorSourceColumns)
  .map(([key, column]) => `source.${column} as "${key}"`)
  .join(
    ", ",
  )}, (select count(*)::integer from behavior_entries entry where entry.source_id = source.id) as "entryCount" from behavior_sources source`
export const behaviorEntrySelect = `select ${Object.entries(behaviorEntryColumns)
  .map(([key, column]) => `${column} as "${key}"`)
  .join(", ")} from behavior_entries`
export type BehaviorSourceRow = Omit<PlatformBehaviorSource, "feedURL">
const iso = (value: string | Date | null): string | null =>
  value === null ? null : new Date(value).toISOString()
export const behaviorSourceFromRow = (row: BehaviorSourceRow): PlatformBehaviorSource => ({
  ...row,
  feedURL: behaviorFeedURL(row.id),
  baselineAt: iso(row.baselineAt),
  createdAt: iso(row.createdAt)!,
  updatedAt: iso(row.updatedAt)!,
  deletedAt: iso(row.deletedAt),
  nextCheckAt: iso(row.nextCheckAt),
  lastAttemptAt: iso(row.lastAttemptAt),
  lastSuccessAt: iso(row.lastSuccessAt),
})
export const behaviorEntryFromRow = (row: PlatformBehaviorEntry): PlatformBehaviorEntry => ({
  ...row,
  occurredAt: iso(row.occurredAt)!,
  discoveredAt: iso(row.discoveredAt)!,
})
export const behaviorSourceValues = (source: PlatformBehaviorSource): unknown[] =>
  Object.keys(behaviorSourceColumns).map((key) => source[key as keyof typeof behaviorSourceColumns])
export const behaviorObjectValues = (object: StoredBehaviorObject): unknown[] =>
  Object.keys(behaviorObjectColumns).map((key) => {
    const value = object[key as keyof typeof behaviorObjectColumns]
    return typeof value === "object" && value !== null ? JSON.stringify(value) : value
  })
export const behaviorEntryValues = (entry: PlatformBehaviorEntry): unknown[] =>
  Object.keys(behaviorEntryColumns).map((key) => entry[key as keyof typeof behaviorEntryColumns])
