import { randomUUID } from "node:crypto"

import type { DataStore, EntryRecord, FeedRecord } from "../../src/data/types"

export const testFeed = (id: string, title: string, at: Date): FeedRecord => ({
  consecutiveFailures: 0,
  description: null,
  errorAt: null,
  errorMessage: null,
  etag: null,
  fetchedAt: at,
  id,
  image: null,
  lastModified: null,
  lastSuccessAt: at,
  nextFetchAt: at,
  ownerUserId: null,
  siteUrl: null,
  title,
  url: `https://example.com/${id}.xml`,
})

export const testEntry = (
  feedId: string,
  id: string,
  title: string,
  insertedAt: Date,
): EntryRecord => ({
  attachments: null,
  author: null,
  authorAvatar: null,
  authorUrl: null,
  categories: null,
  content: `<p>Body of ${title}</p>`,
  description: null,
  extra: null,
  feedId,
  guid: id,
  id,
  insertedAt,
  language: null,
  media: null,
  publishedAt: insertedAt,
  title,
  url: `https://example.com/${id}`,
})

/** Snapshot ids shared by the evaluations `evaluateEntry` writes. */
export const seedSnapshots = async (dataStore: DataStore, userId: string, at: Date) => {
  const profile = await dataStore.createProcessingProfileSnapshot({
    content: { interests: ["AI", "union notices"] },
    contentHash: randomUUID(),
    createdAt: at,
    id: randomUUID(),
    name: "default",
    userId,
    version: 1,
  })
  const taxonomy = await dataStore.createProcessingTaxonomySnapshot({
    content: { categories: [{ name: "科技产业" }, { name: "国际局势" }] },
    contentHash: randomUUID(),
    createdAt: at,
    id: randomUUID(),
    name: "default",
    userId,
    version: 1,
  })
  return { profileSnapshotId: profile.id, taxonomySnapshotId: taxonomy.id }
}

/** Gives an entry a current evaluation through the normal job lifecycle. */
export const evaluateEntry = async (
  dataStore: DataStore,
  input: {
    category: string
    entryId: string
    score: number
    snapshots: { profileSnapshotId: string; taxonomySnapshotId: string }
    userId: string
  },
) => {
  const now = new Date()
  const jobId = randomUUID()
  await dataStore.enqueueProcessingJob({
    attemptCount: 0,
    contentFingerprint: randomUUID(),
    entryId: input.entryId,
    finishedAt: null,
    forceRerun: false,
    id: jobId,
    idempotencyKey: randomUUID(),
    lastErrorCode: null,
    lastErrorSummary: null,
    nextRetryAt: null,
    priority: 0,
    processorName: "test",
    processorVersion: "1",
    profileSnapshotId: input.snapshots.profileSnapshotId,
    purpose: "entry_evaluation",
    queuedAt: now,
    scoreFormulaVersion: "test",
    startedAt: null,
    status: "queued",
    supersededByJobId: null,
    taxonomySnapshotId: input.snapshots.taxonomySnapshotId,
    userId: input.userId,
  })
  const claimed = await dataStore.claimNextProcessingJob(now)
  if (claimed?.id !== jobId) throw new Error("Expected to claim the seeded evaluation job")
  await dataStore.completeProcessingJob({
    attempt: {
      attemptNumber: 1,
      errorSummary: null,
      executionMetadata: null,
      finishedAt: now,
      id: randomUUID(),
      jobId,
      startedAt: now,
      status: "succeeded",
    },
    evaluation: {
      contentFingerprint: claimed.contentFingerprint,
      details: null,
      entryId: input.entryId,
      id: randomUUID(),
      importanceScore: input.score,
      overallScore: input.score,
      primaryCategory: input.category,
      processedAt: now,
      processorName: "test",
      processorType: "ai",
      processorVersion: "1",
      profileSnapshotId: input.snapshots.profileSnapshotId,
      recommendationReason: `Reason for ${input.entryId}`,
      relevanceScore: input.score,
      scoreFormulaVersion: "test",
      secondaryCategory: null,
      tags: ["tag"],
      taxonomySnapshotId: input.snapshots.taxonomySnapshotId,
      timelinessScore: input.score,
    },
    jobId,
  })
}
