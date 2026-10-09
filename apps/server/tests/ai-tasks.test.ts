import { describe, expect, it } from "vitest"

import type { AICompletionRequest, AIProvider } from "../src/ai/provider"
import { taskPromptText } from "../src/ai-tasks/prompt-text"
import { AITaskService } from "../src/ai-tasks/service"
import { MemoryDataStore } from "../src/data/memory-store"
import type { AITaskRecord } from "../src/data/types"
import {
  completeEvaluation,
  evaluateEntry,
  queueEvaluation,
  seedSnapshots,
  testEntry,
  testFeed,
} from "./support/briefing"

const userId = "owner"
const timeZone = "Asia/Shanghai"
// 07:30 in Beijing, as the client sends it from a browser in that zone.
const dailyAt0730 = { type: "daily" as const, timeOfDay: "2026-10-08T23:30:00.000Z" }
const firstSlot = new Date("2026-10-08T23:30:00.000Z")
const secondSlot = new Date("2026-10-09T23:30:00.000Z")

const hoursBefore = (date: Date, hours: number) => new Date(date.getTime() - hours * 3_600_000)
const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000)

interface FakeProvider extends AIProvider {
  requests: AICompletionRequest[]
}

/** Cites every entry it is given, one point each, unless a reply is supplied. */
const fakeProvider = (
  reply?: (request: AICompletionRequest) => string | Promise<string>,
): FakeProvider => {
  const requests: AICompletionRequest[] = []
  return {
    requests,
    async complete(request) {
      requests.push(request)
      const ids = (
        JSON.parse(request.user) as { entries: Array<{ entry_id: string }> }
      ).entries.map((entry) => entry.entry_id)
      return {
        content: reply
          ? await reply(request)
          : JSON.stringify({
              overview: "A calm day.",
              sections: [
                {
                  heading: "Tech",
                  points: ids.map((id) => ({ entry_ids: [id], text: `About ${id}` })),
                },
              ],
            }),
        model: "fake-model",
        usage: { cachedInputTokens: 2, inputTokens: 100, outputTokens: 20 },
      }
    },
  }
}

const setup = async (
  options: { provider?: AIProvider; schedule?: AITaskRecord["schedule"] } = {},
) => {
  const dataStore = new MemoryDataStore()
  const clock = { now: new Date(firstSlot) }
  const provider = options.provider ?? fakeProvider()
  const service = new AITaskService({
    dataStore,
    now: () => clock.now,
    pollIntervalMs: 0,
    resolveProvider: async () => provider,
    timeZone,
  })
  const snapshots = await seedSnapshots(dataStore, userId, hoursBefore(firstSlot, 48))
  await dataStore.saveFeed(testFeed("feed_a", "Wire", hoursBefore(firstSlot, 48)), [])
  await dataStore.createSubscription({
    category: "新闻",
    createdAt: hoursBefore(firstSlot, 48),
    feedId: "feed_a",
    hideFromTimeline: null,
    isPrivate: false,
    title: null,
    userId,
    view: 0,
  })
  const addEntry = async (id: string, insertedAt: Date, score: number | null) => {
    await dataStore.saveFeed(testFeed("feed_a", "Wire", insertedAt), [
      testEntry("feed_a", id, `Title ${id}`, insertedAt),
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
  const task: AITaskRecord = {
    createdAt: hoursBefore(firstSlot, 48),
    id: "task-1",
    isEnabled: true,
    lastError: null,
    lastResult: null,
    lastRunAt: null,
    name: "每日简报",
    nextRunAt: firstSlot,
    options: { notifyChannels: [] },
    prompt: "Keep it short.",
    runCount: 0,
    schedule: options.schedule ?? dailyAt0730,
    updatedAt: hoursBefore(firstSlot, 48),
    userId,
  }
  await dataStore.createAITask(task)
  const reports = async () => {
    const { sessions } = await dataStore.listAIChatSessions(userId, { limit: 100 })
    return Promise.all(
      sessions.map(async (session) => ({
        session,
        text: String(
          (await dataStore.listAIChatMessages(userId, session.chatId, { limit: 10 }))[0]
            ?.messageParts[0]?.text,
        ),
      })),
    )
  }
  return { addEntry, clock, dataStore, provider, reports, service, snapshots, task }
}

describe("scheduled briefings", () => {
  it("writes one report per slot from featured entries of its window", async () => {
    const { addEntry, clock, dataStore, provider, reports, service } = await setup()
    await addEntry("entry_high", hoursBefore(firstSlot, 3), 85)
    await addEntry("entry_also", hoursBefore(firstSlot, 5), 72)
    await addEntry("entry_low", hoursBefore(firstSlot, 2), 40)
    await addEntry("entry_pending", hoursBefore(firstSlot, 1), null)
    await addEntry("entry_old", hoursBefore(firstSlot, 30), 95)

    clock.now = minutesAfter(firstSlot, 1)
    await service.tick()
    // A second pass in the same minute finds nothing new to do.
    await service.tick()

    const fake = provider as FakeProvider
    expect(fake.requests).toHaveLength(1)
    const sent = JSON.parse(fake.requests[0]!.user) as {
      entries: Array<{ entry_id: string; source: string }>
      task_instructions: string
    }
    expect(sent.entries.map((entry) => entry.entry_id)).toEqual(["entry_high", "entry_also"])
    expect(sent.entries[0]!.source).toBe("Wire")
    expect(sent.task_instructions).toBe("Keep it short.")
    expect(fake.requests[0]!.system).toContain("union notices")

    const [report] = await reports()
    expect(report!.session.chatId).toMatch(/^ai-task-task-1-/)
    expect(report!.session.title).toBe("每日简报 · 10月9日")
    expect(report!.session.updatedAt > report!.session.lastSeenAt).toBe(true)
    expect(report!.text).toContain("A calm day.")
    expect(report!.text).toContain("- About entry\\_high [Wire · Title entry\\_high](entry_high)")
    // entry_pending has no evaluation job (no rule covers it), so it is neither waited for nor
    // reported as pending.
    expect(report!.text).toContain("2 条达到精选门槛，入选 2 条。")

    const task = await dataStore.getAITask(userId, "task-1")
    expect(task).toMatchObject({ lastError: null, lastResult: "A calm day.", runCount: 1 })
    expect(task!.nextRunAt).toEqual(secondSlot)
  })

  it("starts the next window where the last successful one ended", async () => {
    const { addEntry, clock, provider, service } = await setup()
    await addEntry("entry_first", hoursBefore(firstSlot, 3), 85)
    clock.now = minutesAfter(firstSlot, 1)
    await service.tick()

    // Imported after the first slot but before the first run finished: belongs to the second.
    await addEntry("entry_late", minutesAfter(firstSlot, 0.5), 80)
    await addEntry("entry_second", hoursBefore(secondSlot, 2), 90)
    clock.now = minutesAfter(secondSlot, 1)
    await service.tick()

    const ids = (provider as FakeProvider).requests.map((request) =>
      (JSON.parse(request.user) as { entries: Array<{ entry_id: string }> }).entries.map(
        (entry) => entry.entry_id,
      ),
    )
    expect(ids).toEqual([["entry_first"], ["entry_second", "entry_late"]])
  })

  it("retries a failed run, then reports the failure and recovers on the next slot", async () => {
    let failing = true
    const cited = fakeProvider()
    const provider = fakeProvider(async (request) => {
      if (failing) throw new Error("provider down")
      return (await cited.complete(request)).content
    })
    const { addEntry, clock, dataStore, reports, service } = await setup({ provider })
    await addEntry("entry_a", hoursBefore(firstSlot, 1), 90)

    clock.now = minutesAfter(firstSlot, 1)
    await service.tick()
    for (const delay of [5, 15, 45]) {
      // Not due yet a minute before the retry.
      clock.now = minutesAfter(clock.now, delay - 1)
      await service.tick()
      clock.now = minutesAfter(clock.now, 1)
      await service.tick()
    }
    expect(provider.requests).toHaveLength(4)
    const [failure] = await reports()
    expect(failure!.text).toContain("这一期简报生成失败（尝试 4 次）")
    expect(failure!.text).toContain("provider down")
    const failed = await dataStore.getAITask(userId, "task-1")
    expect(failed!.lastError).toBe("ai_provider_error: provider down")
    expect(failed!.runCount).toBe(1)

    failing = false
    await addEntry("entry_b", hoursBefore(secondSlot, 1), 90)
    clock.now = minutesAfter(secondSlot, 1)
    await service.tick()
    expect((await dataStore.getAITask(userId, "task-1"))!.lastError).toBeNull()
    // The failed run's window is not carried over: the next one covers one period.
    expect(JSON.parse(provider.requests.at(-1)!.user).period.start).toBe(firstSlot.toISOString())
  })

  it("catches up only the latest slot after downtime", async () => {
    const { addEntry, clock, dataStore, provider, service } = await setup()
    await dataStore.updateAITask(userId, "task-1", {
      nextRunAt: new Date("2026-10-05T23:30:00.000Z"),
    })
    await addEntry("entry_a", hoursBefore(firstSlot, 1), 90)
    clock.now = minutesAfter(firstSlot, 20)
    await service.tick()
    expect((await dataStore.getAITask(userId, "task-1"))!.nextRunAt).toEqual(firstSlot)
    expect(service.runCounts().scheduled.skipped).toBe(1)

    await service.tick()
    expect((provider as FakeProvider).requests).toHaveLength(1)
    expect((await dataStore.getAITask(userId, "task-1"))!.nextRunAt).toEqual(secondSlot)
  })

  it("prints model text as plain text and drops points citing unknown entries", async () => {
    const provider = fakeProvider(() =>
      JSON.stringify({
        overview: "<img src=x onerror=alert(1)> see [this](https://evil.example)",
        sections: [
          {
            heading: "Tech",
            points: [
              {
                entry_ids: ["entry_a", "entry_unknown"],
                text: "Real <mention-entry>x</mention-entry>",
              },
              { entry_ids: ["entry_unknown"], text: "Invented" },
            ],
          },
        ],
      }),
    )
    const { addEntry, clock, reports, service } = await setup({ provider })
    await addEntry("entry_a", hoursBefore(firstSlot, 1), 90)
    clock.now = minutesAfter(firstSlot, 1)
    await service.tick()

    const [report] = await reports()
    // Escaped markup renders as text; nothing reaches the renderer as a tag.
    expect(report!.text).not.toMatch(/(?<!\\)</)
    expect(report!.text).toContain("\\<img src=x onerror=alert(1)\\>")
    expect(report!.text).toContain("\\[this\\](https://evil.example)")
    expect(report!.text).not.toContain("Invented")
    expect(report!.text).not.toContain("entry_unknown")
    expect(report!.text.match(/\]\(entry_a\)/g)).toHaveLength(1)
  })

  it("waits for evaluations still queued at the slot, for at most 30 minutes", async () => {
    const { addEntry, clock, dataStore, provider, reports, service, snapshots } = await setup()
    await addEntry("entry_ready", hoursBefore(firstSlot, 2), 80)
    await addEntry("entry_late", minutesAfter(firstSlot, -1), null)
    const jobId = await queueEvaluation(dataStore, { entryId: "entry_late", snapshots, userId })

    clock.now = minutesAfter(firstSlot, 1)
    await service.tick()
    expect((provider as FakeProvider).requests).toHaveLength(0)
    await completeEvaluation(dataStore, jobId, {
      category: "科技产业",
      entryId: "entry_late",
      score: 90,
      snapshots,
      userId,
    })
    clock.now = minutesAfter(firstSlot, 3)
    await service.tick()
    const sent = JSON.parse((provider as FakeProvider).requests[0]!.user) as {
      entries: Array<{ entry_id: string }>
    }
    expect(sent.entries.map((entry) => entry.entry_id).sort()).toEqual([
      "entry_late",
      "entry_ready",
    ])

    // Waiting does not use up retry attempts, and it gives up after 30 minutes.
    await addEntry("entry_next", hoursBefore(secondSlot, 2), 85)
    await addEntry("entry_stuck", minutesAfter(secondSlot, -1), null)
    await queueEvaluation(dataStore, { entryId: "entry_stuck", snapshots, userId })
    for (let minute = 1; minute <= 31; minute += 2) {
      clock.now = minutesAfter(secondSlot, minute)
      await service.tick()
    }
    expect((provider as FakeProvider).requests).toHaveLength(2)
    const latest = (await reports()).find((report) => report.session.title.endsWith("10月10日"))
    expect(latest!.text).toContain("另有 1 条还在评估队列中，未计入")
  })

  it("reports an empty window without calling the model", async () => {
    const { addEntry, clock, provider, reports, service } = await setup()
    await addEntry("entry_low", hoursBefore(firstSlot, 1), 30)
    clock.now = minutesAfter(firstSlot, 1)
    await service.tick()
    expect((provider as FakeProvider).requests).toHaveLength(0)
    expect((await reports())[0]!.text).toContain("这段时间没有达到精选门槛的新条目")
  })

  it("runs a one-off task once", async () => {
    const { clock, dataStore, service } = await setup({
      schedule: { type: "once", date: firstSlot.toISOString() },
    })
    clock.now = minutesAfter(firstSlot, 1)
    await service.tick()
    await service.tick()
    const task = await dataStore.getAITask(userId, "task-1")
    expect(task).toMatchObject({ nextRunAt: null, runCount: 1 })
  })

  it("test runs report the last period without moving the schedule", async () => {
    const { addEntry, clock, dataStore, reports, service, task } = await setup()
    await addEntry("entry_a", hoursBefore(firstSlot, 30), 90)
    clock.now = hoursBefore(firstSlot, 2)
    const result = await service.testRun(task)
    expect(result).toEqual({ sessionId: expect.stringMatching(/^ai-task-task-1-/) })
    expect((await reports())[0]!.session.title).toContain("试运行")
    expect(await dataStore.getAITask(userId, "task-1")).toMatchObject({
      nextRunAt: firstSlot,
      runCount: 0,
    })
  })
})

describe("task prompt text", () => {
  it("flattens the client's editor state and keeps plain prompts", () => {
    const state = {
      root: {
        children: [
          {
            children: [
              { text: "Focus on ", type: "text" },
              { mentionData: { name: "AI", text: "@AI" }, type: "mention" },
              { type: "linebreak" },
              { text: "Be brief.", type: "text" },
            ],
            type: "paragraph",
          },
          { children: [{ text: "Chinese, please.", type: "text" }], type: "paragraph" },
        ],
        type: "root",
      },
    }
    expect(taskPromptText(JSON.stringify(state))).toBe("Focus on @AI\nBe brief.\nChinese, please.")
    expect(taskPromptText("  plain prompt ")).toBe("plain prompt")
    expect(taskPromptText('{"not":"lexical"}')).toBe('{"not":"lexical"}')
  })
})
