import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { FeedViewType, FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it } from "vitest"

import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

const fixturePath = fileURLToPath(new URL("fixtures/phase-one.rss.xml", import.meta.url))

describe("the client's all-views sentinel", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("reads across every view instead of matching a stored view of -1", async () => {
    const feedXML = await readFile(fixturePath, "utf8")
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "all-view-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new MemoryDataStore(),
      feedFetcher: {
        fetch: async (url) => ({
          body: feedXML,
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
      payload: { email: "reader@example.com", name: "Reader", password: "correct-horse-battery" },
    })
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]
    expect(cookie).toBeTruthy()

    const client = new FollowClient({
      baseURL: "http://localhost:3000",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const response = await server.inject({
          method: request.method as "DELETE" | "GET" | "PATCH" | "POST",
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
      url: "https://feeds.example.com/rss.xml",
      view: FeedViewType.Articles,
    })
    const feedId = created.feed!.id

    // A folder opened from the "all" timeline sends the folder's feeds together with view -1.
    expect(
      (await client.api.entries.list({ view: FeedViewType.All, feedIdList: [feedId] })).data,
    ).toHaveLength(2)
    expect((await client.api.entries.list({ view: FeedViewType.All })).data).toHaveLength(2)
    expect(
      (await client.api.entries.list({ view: FeedViewType.SocialMedia, feedIdList: [feedId] }))
        .data,
    ).toHaveLength(0)

    expect((await client.api.subscriptions.get({ view: FeedViewType.All })).data).toHaveLength(1)
    expect((await client.api.reads.get({ view: FeedViewType.All })).data).toEqual({ [feedId]: 2 })

    await client.api.reads.markAllAsRead({ view: FeedViewType.All, feedIdList: [feedId] })
    expect(
      (await client.api.entries.list({ view: FeedViewType.Articles, read: false })).data,
    ).toHaveLength(0)
  })
})
