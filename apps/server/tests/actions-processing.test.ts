import { setTimeout as delay } from "node:timers/promises"

import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AIProvider } from "../src/ai/provider"
import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Automated feed</title><link>https://example.com</link>
<item><guid>automated-entry</guid><title>Run local evaluation</title><link>https://example.com/local</link>
<description>Evaluate new entries using an owner-controlled model.</description></item>
</channel></rss>`

describe("evaluation action automation", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("persists evaluate rules and automatically queues matching imported entries", async () => {
    const complete = vi.fn<AIProvider["complete"]>().mockResolvedValue({
      content: JSON.stringify({
        importance_score: 75,
        timeliness_score: 75,
        relevance_score: 85,
        recommendation_reason: "Matches the owner's local-first reading profile.",
        primary_category: "Technology",
        tags: ["automatic"],
      }),
      model: "reader-model",
      usage: { inputTokens: 30, outputTokens: 20 },
    })
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "actions-test-secret-that-is-at-least-32-characters",
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
      processingMaxAttempts: 1,
      processingWorkerPollIntervalMs: 5,
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
    const authenticated = async (
      url: string,
      payload?: Record<string, unknown>,
      method: "GET" | "POST" | "PUT" = "POST",
    ) =>
      server.inject({
        method,
        url,
        headers: { cookie: cookie! },
        ...(payload === undefined ? {} : { payload }),
      })

    await authenticated("/api/extensions/profiles", {
      content: { interests: ["local-first"] },
      name: "default",
    })
    await authenticated("/api/extensions/taxonomies", {
      content: { categories: ["Technology"] },
      name: "default",
    })
    const saved = await authenticated(
      "/actions/",
      {
        rules: [
          {
            condition: [],
            name: "Evaluate every new entry",
            result: { evaluate: { priority: "high" } },
          },
        ],
      },
      "PUT",
    )
    expect(saved.statusCode).toBe(200)
    const loaded = await authenticated("/actions/", undefined, "GET")
    expect(loaded.json()).toMatchObject({
      code: 0,
      data: { rules: [{ result: { evaluate: { priority: "high" } } }] },
    })

    const client = new FollowClient({
      baseURL: "http://localhost:3000",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const response = await server.inject({
          method: request.method as "GET" | "POST" | "PUT",
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
    const created = await client.api.subscriptions.create({
      url: "https://feeds.example.com/automated.xml",
      view: 0,
    })
    const entryId = (await client.api.entries.list({ view: 0 })).data.at(0)!.entries.id

    let status: string | undefined
    for (let index = 0; index < 50; index += 1) {
      const response = await authenticated(
        `/api/extensions/entries/${entryId}/processing-status`,
        undefined,
        "GET",
      )
      status = response.json().data.current?.status
      if (status === "succeeded") break
      await delay(5)
    }
    expect(status).toBe("succeeded")
    expect(complete).toHaveBeenCalledTimes(1)

    const succeededStatus = await authenticated(
      `/api/extensions/entries/${entryId}/processing-status`,
      undefined,
      "GET",
    )
    expect(succeededStatus.json().data.current.priority).toBe(5)

    await authenticated("/api/extensions/profiles", {
      content: { interests: ["a newer local-first profile"] },
      name: "default",
    })
    complete.mockRejectedValue(new Error("provider unavailable"))
    await client.api.feeds.refresh({ id: created.feed!.id })
    for (let index = 0; index < 50; index += 1) {
      const response = await authenticated(
        `/api/extensions/entries/${entryId}/processing-status`,
        undefined,
        "GET",
      )
      if (response.json().data.current?.status === "failed") break
      await delay(5)
    }
    expect(complete).toHaveBeenCalledTimes(2)

    await client.api.feeds.refresh({ id: created.feed!.id })
    await delay(20)
    expect(complete).toHaveBeenCalledTimes(2)
  })
})
