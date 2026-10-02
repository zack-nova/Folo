import { randomUUID } from "node:crypto"

import type {
  DataStore,
  ProcessingProfileSnapshotRecord,
  ProcessingTaxonomySnapshotRecord,
} from "../data/types"
import { contentHash } from "./service"

export interface SavedSnapshot<T> {
  created: boolean
  snapshot: T
}

/**
 * Snapshots are immutable: the same name and content reuse the existing version, while new
 * content under the same name becomes the next version.
 */
export const saveProfileSnapshot = async (
  dataStore: DataStore,
  userId: string,
  name: string,
  content: Record<string, unknown>,
): Promise<SavedSnapshot<ProcessingProfileSnapshotRecord>> => {
  const existing = (await dataStore.listProcessingProfileSnapshots(userId)).filter(
    (snapshot) => snapshot.name === name,
  )
  const hash = contentHash(content)
  const matching = existing.find((snapshot) => snapshot.contentHash === hash)
  if (matching) return { created: false, snapshot: matching }
  return {
    created: true,
    snapshot: await dataStore.createProcessingProfileSnapshot({
      content,
      contentHash: hash,
      createdAt: new Date(),
      id: `profile_${randomUUID().replaceAll("-", "")}`,
      name,
      userId,
      version: Math.max(0, ...existing.map((item) => item.version)) + 1,
    }),
  }
}

export const saveTaxonomySnapshot = async (
  dataStore: DataStore,
  userId: string,
  name: string,
  content: Record<string, unknown>,
): Promise<SavedSnapshot<ProcessingTaxonomySnapshotRecord>> => {
  const existing = (await dataStore.listProcessingTaxonomySnapshots(userId)).filter(
    (snapshot) => snapshot.name === name,
  )
  const hash = contentHash(content)
  const matching = existing.find((snapshot) => snapshot.contentHash === hash)
  if (matching) return { created: false, snapshot: matching }
  return {
    created: true,
    snapshot: await dataStore.createProcessingTaxonomySnapshot({
      content,
      contentHash: hash,
      createdAt: new Date(),
      id: `taxonomy_${randomUUID().replaceAll("-", "")}`,
      name,
      userId,
      version: Math.max(0, ...existing.map((item) => item.version)) + 1,
    }),
  }
}
