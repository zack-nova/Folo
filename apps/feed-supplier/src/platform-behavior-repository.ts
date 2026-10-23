import type { PlatformBehaviorEntry, PlatformBehaviorSource } from "@follow/feed-source-contracts"

import type { AuditEventDraft } from "./audit"

export type BehaviorSnapshotValue = boolean | number | string | null
/** The object as the platform described it when it was first seen. */
export type BehaviorSnapshot = Record<string, BehaviorSnapshotValue>

export interface StoredBehaviorObject {
  sourceId: string
  objectKey: string
  occurredAt: string | null
  firstSeenAt: string
  snapshot: BehaviorSnapshot
  /** Entry that published the object, or null for baseline and pre-baseline objects */
  entryGuid: string | null
}

export interface BehaviorRepository {
  countBehaviorSources(now: string): Promise<{ due: number; enabled: number; total: number }>
  createBehaviorSource(
    source: PlatformBehaviorSource,
    audit: AuditEventDraft,
  ): Promise<PlatformBehaviorSource>
  updateBehaviorSource(
    source: PlatformBehaviorSource,
    audit: AuditEventDraft,
  ): Promise<PlatformBehaviorSource | null>
  softDeleteBehaviorSource(
    id: string,
    deletedAt: string,
    audit: AuditEventDraft,
  ): Promise<PlatformBehaviorSource | null>
  findBehaviorSource(id: string): Promise<PlatformBehaviorSource | null>
  listBehaviorSources(): Promise<PlatformBehaviorSource[]>
  listDueBehaviorSources(now: string, limit: number): Promise<PlatformBehaviorSource[]>
  listBehaviorEntries(sourceId: string, limit: number): Promise<PlatformBehaviorEntry[]>
  findBehaviorObjectKeys(sourceId: string, keys: string[]): Promise<string[]>
  /** Saves the check outcome; objects and entries already stored are kept as they are. */
  saveBehaviorObservation(
    source: PlatformBehaviorSource,
    objects: StoredBehaviorObject[],
    entries: PlatformBehaviorEntry[],
  ): Promise<PlatformBehaviorSource>
}
