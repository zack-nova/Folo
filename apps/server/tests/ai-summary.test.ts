import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AIProvider } from "../src/ai/provider"
import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

const longText = "A long article that deserves a full summary. ".repeat(20)
const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Summaries</title><link>https://example.com</link>
<item><guid>short</guid><title>Short post</title><link>https://example.com/short</link>
<description>A two-line post.</description></item>
<item><guid>long</guid><title>Long article</title><link>https://example.com/long</link>
<description>${longText}</description></item>
</channel></rss>`

describe("entry summaries", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("answers cache-only requests without a provider call and reuses short legacy summaries", async () => {
    const complete = vi.fn<AIProvider["complete"]>().mockResolvedValue({
      content: "A generated summary.",
      model: "summary-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "summary-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const dataStore = new MemoryDataStore()
    const server = await buildServer({
      aiProvider: { complete },
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore,
      feedFetcher: {
        fetch: async (url) => ({
          body: rss,
          contentType: "application/rss+xml",
          etag: null,
          lastModified: null,
          url,
        }),
      },
      metricsToken: "metrics-token",
    })
    servers.push(server)

    const registration = await server.inject({
      method: "POST",
      url: "/better-auth/sign-up/email",
      headers: { origin: "http://localhost:2233" },
      payload: { email: "owner@example.com", name: "Owner", password: "correct-horse-battery" },
    })
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]
    expect(cookie).toBeTruthy()
    const userId = (await dataStore.getOwnerUserId())!
    await server.inject({
      method: "POST",
      url: "/subscriptions",
      headers: { cookie: cookie! },
      payload: { url: "https://feeds.example.com/summaries.xml", view: 0 },
    })
    const entries = await server.inject({
      method: "POST",
      url: "/entries",
      headers: { cookie: cookie! },
      payload: { view: 0 },
    })
    const idOf = (title: string) =>
      entries
        .json()
        .data.find((item: { entries: { title: string } }) => item.entries.title === title).entries
        .id as string
    const shortId = idOf("Short post")
    const longId = idOf("Long article")
    // One-sentence summaries written by evaluations before they recorded a language.
    for (const entryId of [shortId, longId]) {
      await dataStore.setEntrySummary(userId, {
        createdAt: new Date(),
        entryId,
        language: "auto",
        model: "evaluation-model",
        summary: "一句话总结。",
        target: "content",
      })
    }
    const summary = (entryId: string, query: string) =>
      server.inject({
        method: "GET",
        url: `/ai/summary?id=${entryId}&target=content&${query}`,
        headers: { cookie: cookie! },
      })

    // The legacy sentence is Chinese, so an English cache-only request finds nothing.
    expect((await summary(shortId, "language=en&cached_only=1")).json()).toEqual({
      code: 0,
      data: null,
    })
    expect((await summary(shortId, "language=zh-CN&cached_only=1")).json()).toEqual({
      code: 0,
      data: "一句话总结。",
    })
    expect(await dataStore.getEntrySummary(userId, shortId, "zh-CN", "content")).toMatchObject({
      summary: "一句话总结。",
    })
    // A long entry deserves more than the legacy sentence.
    expect((await summary(longId, "language=zh-CN&cached_only=1")).json()).toEqual({
      code: 0,
      data: null,
    })
    expect(complete).not.toHaveBeenCalled()

    expect((await summary(longId, "language=zh-CN")).json()).toEqual({
      code: 0,
      data: "A generated summary.",
    })
    expect((await summary(longId, "language=zh-CN&cached_only=1")).json()).toEqual({
      code: 0,
      data: "A generated summary.",
    })
    expect(complete).toHaveBeenCalledTimes(1)

    const metrics = await server.inject({
      headers: { authorization: "Bearer metrics-token" },
      method: "GET",
      url: "/metrics",
    })
    expect(metrics.body).toContain('folo_ai_summaries_total{source="cache_miss"} 2')
    expect(metrics.body).toContain('folo_ai_summaries_total{source="legacy"} 1')
    expect(metrics.body).toContain('folo_ai_summaries_total{source="on_demand"} 1')
    expect(metrics.body).toContain('folo_ai_summaries_total{source="cached"} 1')
  })
})
