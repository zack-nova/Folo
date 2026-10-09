import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { AIProvider } from "../src/ai/provider"
import { AITaskService } from "../src/ai-tasks/service"
import { PostgresDataStore } from "../src/data/postgres-store"
import type { AITaskRecord, AITaskRunRecord } from "../src/data/types"
import {
  completeEvaluation,
  evaluateEntry,
  queueEvaluation,
  seedSnapshots,
  testEntry,
  testFeed,
} from "./support/briefing"
import type { TestDatabase } from "./support/postgres"
import { createTestDatabase, POSTGRES_TEST_TIMEOUT_MS } from "./support/postgres"

const databaseURL = process.env.TEST_DATABASE_URL
const userId = "owner"
const slot = new Date("2026-10-08T23:30:00.000Z")
const hoursBefore = (hours: number) => new Date(slot.getTime() - hours * 3_600_000)

const citingProvider: AIProvider = {
  async complete(request) {
    const { entries } = JSON.parse(request.user) as { entries: Array<{ entry_id: string }> }
    return {
      content: JSON.stringify({
        overview: "Overview.",
        sections: [
          {
            heading: "Tech",
            points: entries.map((entry) => ({ entry_ids: [entry.entry_id], text: "Point" })),
          },
        ],
      }),
      model: "fake",
      usage: { inputTokens: 1, outputTokens: 1 },
    }
  },
}

describe.runIf(databaseURL)("AI tasks in PostgreSQL", { timeout: POSTGRES_TEST_TIMEOUT_MS }, () => {
  let database: TestDatabase
  let dataStore: PostgresDataStore

  beforeAll(async () => {
    database = await createTestDatabase(databaseURL!)
    dataStore = new PostgresDataStore(database.db)
  }, POSTGRES_TEST_TIMEOUT_MS)

  afterAll(async () => {
    await database?.drop()
  })

  const task = (id: string): AITaskRecord => ({
    createdAt: hoursBefore(48),
    id,
    isEnabled: true,
    lastError: null,
    lastResult: null,
    lastRunAt: null,
    name: "每日简报",
    nextRunAt: slot,
    options: { notifyChannels: [] },
    prompt: "Short.",
    runCount: 0,
    schedule: { timeOfDay: slot.toISOString(), type: "daily" },
    updatedAt: hoursBefore(48),
    userId,
  })
  const run = (taskId: string, id: string): AITaskRunRecord => ({
    attemptCount: 0,
    candidateCount: null,
    createdAt: slot,
    errorCode: null,
    errorSummary: null,
    finishedAt: null,
    id,
    kind: "scheduled",
    nextAttemptAt: slot,
    scheduledFor: slot,
    selectedCount: null,
    sessionId: null,
    startedAt: null,
    status: "queued",
    taskId,
    pendingEvaluationCount: null,
    usage: null,
    userId,
    windowEnd: slot,
    windowStart: hoursBefore(24),
  })

  it("records each slot once and claims a run once", async () => {
    await dataStore.createAITask(task("race"))
    const next = new Date(slot.getTime() + 24 * 3_600_000)
    const results = await Promise.all([
      dataStore.scheduleAITaskRun(run("race", "race-a"), next),
      dataStore.scheduleAITaskRun(run("race", "race-b"), next),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await dataStore.getAITask(userId, "race"))!.nextRunAt).toEqual(next)
    // A worker that read the task before it moved finds the slot taken.
    expect(await dataStore.scheduleAITaskRun(run("race", "race-c"), next)).toBe(false)

    const now = new Date(slot.getTime() + 60_000)
    const staleBefore = new Date(now.getTime() - 30 * 60_000)
    const runnable = await dataStore.listRunnableAITaskRuns(now, staleBefore, 10)
    expect(runnable).toHaveLength(1)
    const claims = await Promise.all([
      dataStore.claimAITaskRun(runnable[0]!.id, now, staleBefore),
      dataStore.claimAITaskRun(runnable[0]!.id, now, staleBefore),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(claims.find(Boolean)).toMatchObject({ attemptCount: 1, status: "running" })
    // An interrupted run becomes claimable again once it is stale.
    const later = new Date(now.getTime() + 31 * 60_000)
    expect(
      await dataStore.claimAITaskRun(
        runnable[0]!.id,
        later,
        new Date(later.getTime() - 30 * 60_000),
      ),
    ).toMatchObject({ attemptCount: 2 })
  })

  it("selects candidates, writes the report and pages sessions", async () => {
    const snapshots = await seedSnapshots(dataStore, userId, hoursBefore(48))
    await dataStore.saveFeed(testFeed("feed_pg", "Wire", hoursBefore(48)), [])
    await dataStore.createSubscription({
      category: "新闻",
      createdAt: hoursBefore(48),
      feedId: "feed_pg",
      hideFromTimeline: null,
      isPrivate: false,
      title: "My Wire",
      userId,
      view: 0,
    })
    const add = async (id: string, insertedAt: Date, score: number | null) => {
      await dataStore.saveFeed(testFeed("feed_pg", "Wire", insertedAt), [
        testEntry("feed_pg", id, `Title ${id}`, insertedAt),
      ])
      if (score !== null) {
        await evaluateEntry(dataStore, {
          category: "科技产业",
          entryId: id,
          score,
          snapshots,
          userId,
        })
      }
    }
    await add("entry_pg_high", hoursBefore(2), 90)
    await add("entry_pg_low", hoursBefore(3), 20)
    await add("entry_pg_pending", hoursBefore(4), null)
    await add("entry_pg_old", hoursBefore(30), 90)
    await dataStore.setEntrySummary(userId, {
      createdAt: hoursBefore(1),
      entryId: "entry_pg_high",
      language: "zh-CN",
      model: "fake",
      summary: "Stored summary",
      target: "content",
    })

    const { candidates, pendingEvaluationCount } = await dataStore.listBriefingCandidates({
      insertedAfter: hoursBefore(24),
      insertedBefore: slot,
      minimumScore: 70,
      userId,
    })
    expect(candidates.map((candidate) => candidate.entry.id)).toEqual(["entry_pg_high"])
    expect(candidates[0]).toMatchObject({ feedTitle: "Wire", summary: "Stored summary" })
    expect(candidates[0]!.subscription.title).toBe("My Wire")
    // entry_pg_pending has no evaluation job: no rule covers it, so it is not waited for.
    expect(pendingEvaluationCount).toBe(0)
    await add("entry_pg_queued", hoursBefore(5), null)
    const queuedJobId = await queueEvaluation(dataStore, {
      entryId: "entry_pg_queued",
      snapshots,
      userId,
    })
    expect(
      (
        await dataStore.listBriefingCandidates({
          insertedAfter: hoursBefore(24),
          insertedBefore: slot,
          minimumScore: 70,
          userId,
        })
      ).pendingEvaluationCount,
    ).toBe(1)
    // Finished (below the threshold) so the scheduled run below does not wait for it.
    await completeEvaluation(dataStore, queuedJobId, {
      category: "科技产业",
      entryId: "entry_pg_queued",
      score: 10,
      snapshots,
      userId,
    })

    await dataStore.createAITask(task("brief"))
    const clock = { now: new Date(slot.getTime() + 60_000) }
    const service = new AITaskService({
      dataStore,
      now: () => clock.now,
      pollIntervalMs: 0,
      resolveProvider: async () => citingProvider,
      timeZone: "Asia/Shanghai",
    })
    await service.tick()
    const stored = await dataStore.getAITask(userId, "brief")
    expect(stored).toMatchObject({ lastError: null, lastResult: "Overview.", runCount: 1 })

    const { sessions, total } = await dataStore.listAIChatSessions(userId, { limit: 1 })
    expect(total).toBe(1)
    const [session] = sessions
    expect(session!.chatId).toMatch(/^ai-task-brief-/)
    expect(await dataStore.listUnreadAIChatSessionIds(userId, 10)).toEqual([session!.chatId])
    const [message] = await dataStore.listAIChatMessages(userId, session!.chatId, { limit: 5 })
    expect(JSON.stringify(message!.messageParts)).toContain(
      "[My Wire · Title entry\\\\_pg\\\\_high]",
    )
    expect(
      await dataStore.listAIChatMessages("someone-else", session!.chatId, { limit: 5 }),
    ).toEqual([])
    expect(
      await dataStore.listAIChatSessions(userId, { before: session!.updatedAt, limit: 5 }),
    ).toMatchObject({ sessions: [] })

    await dataStore.updateAIChatSession(userId, session!.chatId, { lastSeenAt: clock.now })
    expect(await dataStore.listUnreadAIChatSessionIds(userId, 10)).toEqual([])
    // Deleting the task keeps its reports.
    expect(await dataStore.deleteAITask(userId, "brief")).toBe(true)
    expect(await dataStore.getAIChatSession(userId, session!.chatId)).not.toBeNull()
    expect(await dataStore.deleteAIChatSession(userId, session!.chatId)).toBe(true)
    expect(await dataStore.listAIChatMessages(userId, session!.chatId, { limit: 5 })).toEqual([])
  })
})
