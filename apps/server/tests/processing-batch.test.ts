import { setTimeout as delay } from "node:timers/promises"

import { describe, expect, it, vi } from "vitest"

import type { AICompletionRequest, AIProvider } from "../src/ai/provider"
import { MemoryDataStore } from "../src/data/memory-store"
import type {
  EnqueueProcessingJobResult,
  EntryRecord,
  FeedRecord,
  ProcessingJobRecord,
} from "../src/data/types"
import { ProcessingService } from "../src/processing/service"
import { saveProfileSnapshot, saveTaxonomySnapshot } from "../src/processing/snapshots"

const userId = "owner"
const feedId = "feed_batch"
const now = new Date("2026-10-08T12:00:00.000Z")

const feed: FeedRecord = {
  consecutiveFailures: 0,
  description: null,
  errorAt: null,
  errorMessage: null,
  etag: null,
  fetchedAt: now,
  id: feedId,
  image: null,
  lastModified: null,
  lastSuccessAt: now,
  nextFetchAt: now,
  ownerUserId: null,
  siteUrl: "https://example.com",
  title: "Batch feed",
  url: "https://example.com/feed.xml",
}

const entry = (id: string, content: string): EntryRecord => ({
  attachments: null,
  author: null,
  authorAvatar: null,
  authorUrl: null,
  categories: null,
  content: `<p>${content}</p>`,
  description: null,
  extra: null,
  feedId,
  guid: id,
  id,
  insertedAt: now,
  language: null,
  media: null,
  publishedAt: now,
  title: `Title ${id}`,
  url: `https://example.com/${id}`,
})

const evaluationFor = (entryId: string, relevance = 80) => ({
  entry_id: entryId,
  importance_score: 60,
  primary_category: "Technology",
  recommendation_reason: `Reason for ${entryId}`,
  relevance_score: relevance,
  tags: ["batch"],
  timeliness_score: 50,
})

const batchReply = (request: AICompletionRequest) => {
  const { entries } = JSON.parse(request.user) as { entries: { entry_id: string }[] }
  return { evaluations: entries.map((item) => evaluationFor(item.entry_id)) }
}

const seed = async (dataStore: MemoryDataStore, entries: EntryRecord[]) => {
  await dataStore.saveFeed(feed, entries)
  await dataStore.createSubscription({
    category: "科技产业·AI 官方源",
    createdAt: now,
    feedId,
    hideFromTimeline: false,
    isPrivate: false,
    title: null,
    userId,
    view: 0,
  })
  await saveProfileSnapshot(dataStore, userId, "default", { interests: ["AI"] })
  await saveTaxonomySnapshot(dataStore, userId, "default", { categories: ["Technology"] })
}

const jobIdOf = (result: EnqueueProcessingJobResult): string => {
  if (result.outcome === "already_satisfied") throw new Error("expected a job")
  return result.job.id
}

const settle = async (dataStore: MemoryDataStore, jobIds: string[]) => {
  for (let index = 0; index < 200; index += 1) {
    const jobs = await Promise.all(jobIds.map((id) => dataStore.getProcessingJob(userId, id)))
    if (jobs.every((job) => job && job.status !== "queued" && job.status !== "running")) {
      return jobs as ProcessingJobRecord[]
    }
    await delay(5)
  }
  throw new Error("jobs did not settle")
}

describe("batched entry evaluation", () => {
  it("evaluates automatic jobs of one configuration in a single provider call", async () => {
    const dataStore = new MemoryDataStore()
    await seed(dataStore, [entry("e1", "one"), entry("e2", "two"), entry("e3", "three")])
    const complete = vi.fn<AIProvider["complete"]>().mockImplementation(async (request) => ({
      content: JSON.stringify(batchReply(request)),
      model: "batch-model",
      usage: { cachedInputTokens: 100, inputTokens: 120, outputTokens: 60 },
    }))
    const service = new ProcessingService({
      batchSize: 10,
      dataStore,
      pollIntervalMs: 5,
      resolveProvider: async () => ({ complete }),
    })
    service.start()
    try {
      const results = await Promise.all(
        ["e1", "e2", "e3"].map((id) => service.enqueueEvaluation(userId, id, { automatic: true })),
      )
      const jobs = await settle(dataStore, results.map(jobIdOf))
      expect(jobs.map((job) => job.status)).toEqual(["succeeded", "succeeded", "succeeded"])
      expect(complete).toHaveBeenCalledTimes(1)
      const request = complete.mock.calls[0]![0]
      expect(request.system).toContain("a batch of RSS entries")
      const payload = JSON.parse(request.user) as {
        entries: { entry_id: string; entry: { title: string }; source: { category: string } }[]
      }
      expect(payload.entries.map((item) => item.entry_id)).toEqual(["e1", "e2", "e3"])
      expect(payload.entries[0]!.source.category).toBe("科技产业·AI 官方源")
      const evaluation = await dataStore.getCurrentEntryEvaluation(userId, "e2")
      expect(evaluation).toMatchObject({
        details: { batch: { size: 3 }, model: "batch-model" },
        overallScore: Math.round(60 * 0.3 + 50 * 0.2 + 80 * 0.5),
        recommendationReason: "Reason for e2",
      })
      // Tokens are counted once per call, not once per entry.
      expect(service.tokenUsage()).toEqual({ cachedInput: 100, input: 120, output: 60 })
      expect(service.callCounts()).toEqual({ batch: 1, batched: 3, single: 0 })
    } finally {
      await service.stop()
    }
  })

  it("fails only the entries missing from the reply and retries them alone", async () => {
    const dataStore = new MemoryDataStore()
    await seed(dataStore, [entry("e1", "one"), entry("e2", "two")])
    const complete = vi.fn<AIProvider["complete"]>().mockImplementation(async (request) => {
      const payload = JSON.parse(request.user) as { entries?: unknown[]; entry?: unknown }
      if (payload.entries) {
        // The batch reply drops e2 and includes an entry that was never sent.
        return {
          content: JSON.stringify({ evaluations: [evaluationFor("e1"), evaluationFor("ghost")] }),
          model: "batch-model",
          usage: { inputTokens: 10, outputTokens: 5 },
        }
      }
      const { entry_id, ...single } = evaluationFor("e2", 95)
      void entry_id
      return {
        content: JSON.stringify(single),
        model: "single-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      }
    })
    const service = new ProcessingService({
      batchSize: 10,
      dataStore,
      pollIntervalMs: 5,
      resolveProvider: async () => ({ complete }),
      retryBaseDelayMs: 1,
    })
    service.start()
    try {
      const results = await Promise.all(
        ["e1", "e2"].map((id) => service.enqueueEvaluation(userId, id, { automatic: true })),
      )
      const jobs = await settle(dataStore, results.map(jobIdOf))
      expect(jobs.map((job) => job.status)).toEqual(["succeeded", "succeeded"])
      // One batch call, then e2 retried on its own with the single-entry prompt.
      expect(complete).toHaveBeenCalledTimes(2)
      expect(complete.mock.calls[1]![0].system).toContain("one RSS entry")
      expect(jobs[1]).toMatchObject({ attemptCount: 2 })
      expect(await dataStore.listProcessingAttempts(userId, jobs[1]!.id)).toMatchObject([
        { attemptNumber: 1, status: "failed" },
        { attemptNumber: 2, status: "succeeded" },
      ])
      expect(await dataStore.getCurrentEntryEvaluation(userId, "e2")).toMatchObject({
        details: { model: "single-model" },
        relevanceScore: 95,
      })
      expect(await dataStore.getCurrentEntryEvaluation(userId, "ghost")).toBeNull()
      expect(service.callCounts()).toEqual({ batch: 1, batched: 2, single: 1 })
    } finally {
      await service.stop()
    }
  })

  it("keeps owner re-evaluations single and splits batches by the text budget", async () => {
    const dataStore = new MemoryDataStore()
    await seed(dataStore, [
      entry("long1", "a".repeat(900)),
      entry("long2", "b".repeat(900)),
      entry("short", "c"),
      entry("manual", "d"),
    ])
    const complete = vi.fn<AIProvider["complete"]>().mockImplementation(async (request) => {
      const payload = JSON.parse(request.user) as { entries?: unknown[] }
      if (payload.entries) {
        return {
          content: JSON.stringify(batchReply(request)),
          model: "batch-model",
          usage: { inputTokens: 10, outputTokens: 5 },
        }
      }
      const { entry_id, ...single } = evaluationFor("manual")
      void entry_id
      return {
        content: JSON.stringify(single),
        model: "single-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      }
    })
    const service = new ProcessingService({
      batchMaxCharacters: 1_000,
      batchSize: 10,
      dataStore,
      pollIntervalMs: 5,
      resolveProvider: async () => ({ complete }),
    })
    try {
      const results = await Promise.all([
        service.enqueueEvaluation(userId, "long1", { automatic: true }),
        service.enqueueEvaluation(userId, "long2", { automatic: true }),
        service.enqueueEvaluation(userId, "short", { automatic: true }),
        service.enqueueEvaluation(userId, "manual", { forceRerun: true }),
      ])
      service.start()
      const jobs = await settle(dataStore, results.map(jobIdOf))
      expect(jobs.map((job) => job.status)).toEqual([
        "succeeded",
        "succeeded",
        "succeeded",
        "succeeded",
      ])
      const batches = complete.mock.calls
        .map(([request]) => JSON.parse(request.user) as { entries?: { entry_id: string }[] })
        .filter((payload) => payload.entries)
        .map((payload) => payload.entries!.map((item) => item.entry_id))
      // long2 does not fit beside long1, so long1 runs alone (single prompt) and long2 starts
      // the next batch together with short.
      expect(batches).toEqual([["long2", "short"]])
      expect(service.callCounts()).toEqual({ batch: 1, batched: 2, single: 2 })
      expect(await dataStore.getCurrentEntryEvaluation(userId, "manual")).toMatchObject({
        details: { model: "single-model" },
      })
    } finally {
      await service.stop()
    }
  })

  it("evaluates one entry per call when the batch size is 1", async () => {
    const dataStore = new MemoryDataStore()
    await seed(dataStore, [entry("e1", "one"), entry("e2", "two")])
    const complete = vi.fn<AIProvider["complete"]>().mockImplementation(async () => {
      const { entry_id, ...single } = evaluationFor("any")
      void entry_id
      return {
        content: JSON.stringify(single),
        model: "single-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      }
    })
    const service = new ProcessingService({
      batchSize: 1,
      dataStore,
      pollIntervalMs: 5,
      resolveProvider: async () => ({ complete }),
    })
    service.start()
    try {
      const results = await Promise.all(
        ["e1", "e2"].map((id) => service.enqueueEvaluation(userId, id, { automatic: true })),
      )
      await settle(dataStore, results.map(jobIdOf))
      expect(complete).toHaveBeenCalledTimes(2)
      expect(service.callCounts()).toEqual({ batch: 0, batched: 0, single: 2 })
    } finally {
      await service.stop()
    }
  })
})
