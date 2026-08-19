import { describe, expect, it } from "vitest"

import { MemoryDataStore } from "../src/data/memory-store"
import type { FeedRecord, ProcessingJobRecord } from "../src/data/types"

describe("maintenance retention", () => {
  it("removes old acquisition diagnostics and terminal jobs while preserving active jobs", async () => {
    const dataStore = new MemoryDataStore()
    const now = new Date("2026-08-18T00:00:00.000Z")
    const old = new Date("2025-12-01T00:00:00.000Z")
    const feed: FeedRecord = {
      consecutiveFailures: 0,
      description: null,
      errorAt: null,
      errorMessage: null,
      etag: null,
      fetchedAt: old,
      id: "feed-maintenance",
      image: null,
      lastModified: null,
      lastSuccessAt: old,
      nextFetchAt: now,
      ownerUserId: null,
      siteUrl: null,
      title: "Maintenance",
      url: "https://feeds.example.com/maintenance.xml",
    }
    await dataStore.saveFeed(feed, [], {
      durationMs: 10,
      entryCount: 0,
      errorCode: null,
      errorSummary: null,
      feedId: feed.id,
      finishedAt: old,
      httpStatus: 200,
      id: "fetch-old",
      responseUrl: feed.url,
      startedAt: old,
      status: "succeeded",
    })
    const job = (status: ProcessingJobRecord["status"], id: string): ProcessingJobRecord => ({
      attemptCount: 0,
      contentFingerprint: "fingerprint",
      entryId: `entry-${id}`,
      finishedAt: status === "queued" ? null : old,
      forceRerun: false,
      id,
      idempotencyKey: id,
      lastErrorCode: null,
      lastErrorSummary: null,
      nextRetryAt: null,
      priority: 0,
      processorName: "processor",
      processorVersion: "1",
      profileSnapshotId: "profile",
      purpose: "entry_evaluation",
      queuedAt: old,
      scoreFormulaVersion: "formula",
      startedAt: null,
      status,
      supersededByJobId: null,
      taxonomySnapshotId: "taxonomy",
      userId: "user-1",
    })
    await dataStore.enqueueProcessingJob(job("succeeded", "old-terminal"))
    await dataStore.enqueueProcessingJob(job("queued", "active"))

    const report = await dataStore.cleanupProcessingHistory(now)

    expect(report).toMatchObject({ feedFetchAttemptsDeleted: 1, processingJobsDeleted: 1 })
    expect(await dataStore.getProcessingJob("user-1", "old-terminal")).toBeNull()
    expect(await dataStore.getProcessingJob("user-1", "active")).not.toBeNull()
  })
})
