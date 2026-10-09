import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it } from "vitest"

import type { AIProvider } from "../src/ai/provider"
import { nextScheduleRun, schedulePeriodStart } from "../src/ai-tasks/schedule"
import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"
import { evaluateEntry, seedSnapshots, testEntry, testFeed } from "./support/briefing"

const origin = "http://localhost:2233"

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

describe("AI task and report routes", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  const start = async () => {
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "ai-task-routes-test-secret-that-is-at-least-32-chars",
      trustedOrigins: [origin],
    })
    const dataStore = new MemoryDataStore()
    const server = await buildServer({
      aiProvider: citingProvider,
      aiTaskPollIntervalMs: 0,
      aiTaskTimeZone: "Asia/Shanghai",
      auth,
      clientOrigins: [origin],
      dataStore,
    })
    servers.push(server)
    const registration = await server.inject({
      headers: { origin },
      method: "POST",
      payload: { email: "owner@example.com", name: "Owner", password: "correct-horse-battery" },
      url: "/better-auth/sign-up/email",
    })
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]
    const client = new FollowClient({
      baseURL: "http://localhost:3000",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const response = await server.inject({
          headers: { ...Object.fromEntries(request.headers.entries()), cookie: cookie!, origin },
          method: request.method as "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
          payload:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : await request.text(),
          url: new URL(request.url).pathname + new URL(request.url).search,
        })
        return new Response(response.statusCode === 204 ? null : response.body, {
          headers: response.headers as unknown as HeadersInit,
          status: response.statusCode,
        })
      },
    })
    const userId = (await dataStore.getOwnerUserId())!
    return { client, cookie: cookie!, dataStore, server, userId }
  }

  it("manages tasks with the client's payloads", async () => {
    const { client, server } = await start()
    const daily = { timeOfDay: "2026-10-08T23:30:00.000Z", type: "daily" as const }
    const created = await client.api.aiTask.create({
      name: "每日简报",
      options: { notifyChannels: [] },
      prompt: JSON.stringify({ root: { children: [], type: "root" } }),
      schedule: daily,
    })
    expect(created.data).toMatchObject({
      isEnabled: true,
      lastRunAt: null,
      name: "每日简报",
      runCount: 0,
    })
    expect(new Date(created.data.nextRunAt!).toISOString()).toMatch(/T23:30:00\.000Z$/)

    const email = await server.inject({
      headers: { origin },
      method: "POST",
      payload: { name: "x", options: { notifyChannels: ["email"] }, prompt: "x", schedule: daily },
      url: "/ai/task",
    })
    // Unauthenticated requests are rejected before validation.
    expect(email.statusCode).toBe(401)
    await expect(
      client.api.aiTask.create({
        name: "Mail me",
        options: { notifyChannels: ["email"] },
        prompt: "x",
        schedule: daily,
      }),
    ).rejects.toMatchObject({ status: 400 })

    const paused = await client.api.aiTask.update({ id: created.data.id, isEnabled: false })
    expect(paused.data).toMatchObject({ isEnabled: false, nextRunAt: null })
    const resumed = await client.api.aiTask.update({ id: created.data.id, isEnabled: true })
    expect(resumed.data.nextRunAt).not.toBeNull()

    expect((await client.api.aiTask.list()).data).toHaveLength(1)
    await client.api.aiTask.delete({ id: created.data.id })
    expect((await client.api.aiTask.list()).data).toHaveLength(0)

    for (let index = 0; index < 10; index += 1) {
      await client.api.aiTask.create({
        name: `Task ${index}`,
        options: { notifyChannels: [] },
        prompt: "x",
        schedule: daily,
      })
    }
    await expect(
      client.api.aiTask.create({
        name: "Eleventh",
        options: { notifyChannels: [] },
        prompt: "x",
        schedule: daily,
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it("serves a test run as a read-only report session", async () => {
    const { client, cookie, dataStore, server, userId } = await start()
    const now = new Date()
    const snapshots = await seedSnapshots(dataStore, userId, now)
    await dataStore.saveFeed(testFeed("feed_a", "Wire", now), [
      testEntry("feed_a", "entry_0123456789abcdef01234567", "Big news", now),
    ])
    await dataStore.createSubscription({
      category: null,
      createdAt: now,
      feedId: "feed_a",
      hideFromTimeline: null,
      isPrivate: false,
      title: null,
      userId,
      view: 0,
    })
    await evaluateEntry(dataStore, {
      category: "科技产业",
      entryId: "entry_0123456789abcdef01234567",
      score: 88,
      snapshots,
      userId,
    })

    const task = await client.api.aiTask.create({
      name: "Brief",
      options: { notifyChannels: [] },
      prompt: "Short.",
      schedule: { timeOfDay: now.toISOString(), type: "daily" },
    })
    const testRun = await client.api.aiTask.testRun({ id: task.data.id })
    const sessionId = testRun.data.sessionId!
    expect(sessionId.startsWith(`ai-task-${task.data.id}`)).toBe(true)

    const sessions = await client.api.aiChatSessions.list({})
    expect(sessions.total).toBe(1)
    expect(sessions.data[0]).toMatchObject({ chatId: sessionId, userId })
    expect((await client.api.aiChatSessions.unread({})).data).toEqual([sessionId])

    const messages = await client.api.aiChatSessions.messages.get({ chatId: sessionId })
    const [message] = messages.data.messages
    expect(message).toMatchObject({ role: "assistant", status: "completed" })
    expect(message!.metadata).toMatchObject({ modelUsed: "fake" })
    expect(JSON.stringify(message!.messageParts)).toContain(
      "[Wire · Big news](entry_0123456789abcdef01234567)",
    )

    const stream = await server.inject({
      headers: { cookie },
      method: "GET",
      url: `/ai/chat/${encodeURIComponent(sessionId)}/stream`,
    })
    expect(stream.statusCode).toBe(204)
    const chat = await server.inject({
      headers: { cookie, origin },
      method: "POST",
      payload: {},
      url: "/ai/chat",
    })
    expect(chat.statusCode).toBe(501)

    await client.api.aiChatSessions.markSeen({ chatId: sessionId })
    expect((await client.api.aiChatSessions.unread({})).data).toEqual([])
    await client.api.aiChatSessions.update({ chatId: sessionId, title: "Renamed" })
    expect((await client.api.aiChatSessions.get({ chatId: sessionId })).data.title).toBe("Renamed")
    await client.api.aiChatSessions.delete({ chatId: sessionId })
    expect((await client.api.aiChatSessions.list({})).total).toBe(0)
    // The task keeps its schedule after a test run.
    expect((await client.api.aiTask.get({ id: task.data.id })).data.runCount).toBe(0)
  })

  it("advertises the task capabilities but not general chat", async () => {
    const { server } = await start()
    const response = await server.inject({ method: "GET", url: "/api/extensions/capabilities" })
    const { data } = response.json() as {
      data: { capabilities: Array<{ id: string }>; unavailable: string[] }
    }
    const ids = data.capabilities.map((capability) => capability.id)
    expect(ids).toEqual(expect.arrayContaining(["ai.scheduled_tasks", "ai.task_reports"]))
    expect(ids).not.toContain("ai.chat")
    expect(data.unavailable).toContain("ai.chat")
  })
})

describe("task schedules", () => {
  it("reads times, weekdays and month days in the configured zone", () => {
    const zone = "Asia/Shanghai"
    const after = new Date("2026-10-09T05:00:00.000Z")
    // Monday 09:00 in Beijing is Monday 01:00 UTC.
    expect(
      nextScheduleRun(
        { dayOfWeek: 1, timeOfDay: "2026-10-08T01:00:00.000Z", type: "weekly" },
        after,
        zone,
      ),
    ).toEqual(new Date("2026-10-12T01:00:00.000Z"))
    // The 31st falls on the last day of a shorter month.
    expect(
      nextScheduleRun(
        { dayOfMonth: 31, timeOfDay: "2026-10-08T01:00:00.000Z", type: "monthly" },
        new Date("2026-11-01T00:00:00.000Z"),
        zone,
      ),
    ).toEqual(new Date("2026-11-30T01:00:00.000Z"))
    // 07:30 stays 07:30 local across the end of daylight saving time.
    expect(
      nextScheduleRun(
        { timeOfDay: "2026-10-09T11:30:00.000Z", type: "daily" },
        new Date("2026-11-01T12:00:00.000Z"),
        "America/New_York",
      ),
    ).toEqual(new Date("2026-11-01T12:30:00.000Z"))
    expect(
      schedulePeriodStart(
        { timeOfDay: "2026-10-08T23:30:00.000Z", type: "daily" },
        new Date("2026-10-09T23:30:00.000Z"),
        zone,
      ),
    ).toEqual(new Date("2026-10-08T23:30:00.000Z"))
  })
})
