import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AIProvider } from "../src/ai/provider"
import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Language feed</title><link>https://example.com</link>
<item><guid>language-entry</guid><title>Independent reading</title><link>https://example.com/read</link>
<description><![CDATA[<p>Own the feed, the model, and the generated result.</p>]]></description></item>
</channel></rss>`

describe("Follow-compatible local AI entry processing", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("generates and caches summaries and streamed translations with the owner's provider", async () => {
    const complete = vi.fn<AIProvider["complete"]>().mockImplementation(async (request) => ({
      content: request.json
        ? JSON.stringify({
            description: "掌控信息源、模型和生成结果。",
            title: "自主阅读",
          })
        : "The reader owns the source, model, and generated result.",
      model: "reader-model",
      usage: { inputTokens: 20, outputTokens: 10 },
    }))
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "ai-entry-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({
      aiProvider: { complete },
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new MemoryDataStore(),
      feedFetcher: {
        fetch: async (url) => ({
          body: rss,
          contentType: "application/rss+xml",
          etag: null,
          lastModified: null,
          url,
        }),
      },
    })
    servers.push(server)

    const registration = await server.inject({
      method: "POST",
      url: "/better-auth/sign-up/email",
      headers: { origin: "http://localhost:2233" },
      payload: {
        email: "owner@example.com",
        name: "Owner",
        password: "correct-horse-battery-staple",
      },
    })
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]
    const client = new FollowClient({
      baseURL: "http://localhost:3000",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const response = await server.inject({
          method: request.method as "GET" | "POST",
          url: new URL(request.url).pathname + new URL(request.url).search,
          headers: { ...Object.fromEntries(request.headers.entries()), cookie: cookie! },
          payload:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : await request.text(),
        })
        return new Response(response.body, {
          status: response.statusCode,
          headers: response.headers as unknown as HeadersInit,
        })
      },
    })

    await client.api.subscriptions.create({
      url: "https://feeds.example.com/language.xml",
      view: 0,
    })
    const entryId = (await client.api.entries.list({ view: 0 })).data.at(0)!.entries.id

    const firstSummary = await client.api.ai.summary({
      id: entryId,
      language: "en",
      target: "content",
    })
    const secondSummary = await client.api.ai.summary({
      id: entryId,
      language: "en",
      target: "content",
    })
    expect(firstSummary.data).toBe("The reader owns the source, model, and generated result.")
    expect(secondSummary).toEqual(firstSummary)

    const firstTranslation = await client.api.ai.translationBatch({
      fields: "title,description",
      ids: [entryId],
      language: "zh-CN",
      mode: "bilingual",
    })
    expect(JSON.parse((await firstTranslation.text()).trim())).toEqual({
      id: entryId,
      data: { description: "掌控信息源、模型和生成结果。", title: "自主阅读" },
    })
    const cachedTranslation = await client.api.ai.translationBatch({
      fields: "title,description",
      ids: [entryId],
      language: "zh-CN",
      mode: "bilingual",
    })
    expect((await cachedTranslation.text()).trim()).toContain("自主阅读")
    expect(complete).toHaveBeenCalledTimes(2)
  })
})
