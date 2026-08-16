import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it } from "vitest"

import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

const fixturePath = fileURLToPath(new URL("fixtures/phase-one.rss.xml", import.meta.url))

describe("self-hosted reading loop", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("subscribes to a standard RSS feed and exposes imported entries through the frozen SDK", async () => {
    const feedXML = await readFile(fixturePath, "utf8")
    let fetchedXML = feedXML
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "phase-one-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new MemoryDataStore(),
      feedFetcher: {
        fetch: async (url) => ({
          body: fetchedXML,
          contentType: "application/rss+xml",
          etag: '"phase-one"',
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
        email: "reader@example.com",
        name: "Reader",
        password: "correct-horse-battery-staple",
      },
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
          headers: {
            ...Object.fromEntries(request.headers.entries()),
            cookie: cookie!,
          },
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

    const initialSettings = await client.api.settings.get()
    expect(initialSettings.settings).toEqual({
      ai: {},
      appearance: {},
      general: {},
      integration: {},
    })
    await client.api.settings.update({ tab: "general", language: "zh-CN" })
    expect((await client.api.settings.get()).settings.general).toEqual({ language: "zh-CN" })

    const feedURL = "https://feeds.example.com/rss.xml"
    const feedPreview = await client.api.feeds.get({ url: feedURL, entriesLimit: 1 })
    expect(feedPreview.data).toMatchObject({
      feed: { title: "Phase One Feed", url: feedURL },
      entries: [{ title: "Second entry" }],
      readCount: 0,
      subscriptionCount: 0,
    })

    const discovered = await client.api.discover.discover({ keyword: feedURL, target: "feeds" })
    expect(discovered.data).toHaveLength(1)
    expect(discovered.data[0]).toMatchObject({
      feed: { title: "Phase One Feed", url: feedURL },
      entries: [{ title: "Second entry" }, { title: "First entry" }],
    })

    const created = await client.api.subscriptions.create({
      url: feedURL,
      view: 0,
    })
    expect(created.feed).toMatchObject({
      title: "Phase One Feed",
      url: "https://feeds.example.com/rss.xml",
    })
    expect(created.unread[created.feed!.id]).toBe(2)

    const subscriptions = await client.api.subscriptions.get({ view: 0 })
    expect(subscriptions.data).toHaveLength(1)
    expect(subscriptions.data[0]).toMatchObject({
      feeds: { id: created.feed!.id, title: "Phase One Feed" },
      userId: registration.json().user.id,
      view: 0,
    })

    const subscribedFeed = await client.api.feeds.get({ id: created.feed!.id })
    expect(subscribedFeed.data).toMatchObject({
      feed: { id: created.feed!.id },
      entries: [{ title: "Second entry" }, { title: "First entry" }],
      subscription: { feedId: created.feed!.id },
      readCount: 0,
      subscriptionCount: 1,
    })

    const updatedSubscription = await client.api.subscriptions.update({
      feedId: created.feed!.id,
      category: "Engineering",
      title: "My Phase One Feed",
    })
    expect(updatedSubscription.data).toMatchObject({
      feedId: created.feed!.id,
      category: "Engineering",
      title: "My Phase One Feed",
    })

    const entries = await client.api.entries.list({ limit: 20, view: 0 })
    expect(entries.data).toHaveLength(2)
    expect(entries.data.map((item) => item.entries.title)).toEqual(["Second entry", "First entry"])
    expect(entries.data[0]).toMatchObject({
      read: false,
      feeds: { id: created.feed!.id },
      entries: { description: "Second description" },
    })
    expect(entries.data[0]?.entries).not.toHaveProperty("content")

    const firstPage = await client.api.entries.list({ limit: 1, view: 0 })
    const secondPage = await client.api.entries.list({
      limit: 1,
      publishedBefore: firstPage.data[0]!.entries.publishedAt,
      view: 0,
    })
    expect(firstPage.data[0]!.entries.title).toBe("Second entry")
    expect(secondPage.data[0]!.entries.title).toBe("First entry")

    const entryId = entries.data[0]!.entries.id
    const detail = await client.api.entries.get({ id: entryId })
    expect(detail.data).toMatchObject({
      entries: { id: entryId, content: "<p>Second full content</p>" },
      feeds: { id: created.feed!.id },
    })
    expect((await client.api.entries.preview({ id: entryId })).data).toMatchObject({
      id: entryId,
      content: "<p>Second full content</p>",
    })
    expect((await client.api.entries.readability({ id: entryId })).data).toEqual({
      content: "<p>Second full content</p>",
    })

    const stream = await client.api.entries.stream({ ids: [entryId] })
    expect(stream.status).toBe(200)
    expect(await stream.text()).toBe(
      `${JSON.stringify({ id: entryId, content: "<p>Second full content</p>" })}\n`,
    )

    const initialUnread = await client.api.reads.get({ view: 0 })
    expect(initialUnread.data).toEqual({ [created.feed!.id]: 2 })

    await client.api.reads.markAsRead({ entryIds: [entryId] })
    expect((await client.api.reads.getTotalCount()).data.count).toBe(1)
    expect((await client.api.entries.list({ read: false, view: 0 })).data).toHaveLength(1)

    await client.api.reads.markAsUnread({ entryId })
    expect((await client.api.reads.get({ view: 0 })).data).toEqual({ [created.feed!.id]: 2 })

    expect((await client.api.collections.get({ entryId })).data).toBe(false)
    await client.api.collections.post({ entryId, view: 0 })
    expect((await client.api.collections.get({ entryId })).data).toBe(true)

    const collectionEntries = await client.api.entries.list({ isCollection: true, view: 0 })
    expect(collectionEntries.data).toHaveLength(1)
    expect(collectionEntries.data[0]).toMatchObject({
      collections: { createdAt: expect.any(String) },
      entries: { id: entryId },
    })

    await client.api.collections.delete({ entryId })
    expect((await client.api.collections.get({ entryId })).data).toBe(false)

    fetchedXML = feedXML.replace(
      "</channel>",
      `<item>
        <guid isPermaLink="false">phase-one-entry-3</guid>
        <title>Third entry</title>
        <link>https://feeds.example.com/third</link>
        <description>Third description</description>
        <pubDate>Sat, 16 Aug 2026 03:00:00 GMT</pubDate>
      </item></channel>`,
    )
    await client.api.feeds.refresh({ id: created.feed!.id })
    expect((await client.api.entries.list({ view: 0 })).data).toHaveLength(3)

    await client.api.feeds.refresh({ id: created.feed!.id })
    expect((await client.api.entries.list({ view: 0 })).data).toHaveLength(3)

    await client.api.feeds.reset({ id: created.feed!.id })
    const analytics = await client.api.feeds.analytics({ id: [created.feed!.id] })
    expect(analytics.data.analytics[created.feed!.id]).toMatchObject({
      subscriptionCount: 1,
      updatesPerWeek: 3,
    })

    await client.api.subscriptions.delete({ feedId: created.feed!.id })
    expect((await client.api.subscriptions.get({ view: 0 })).data).toEqual([])
  })
})
