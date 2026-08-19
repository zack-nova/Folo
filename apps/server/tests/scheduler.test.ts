import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { MemoryDataStore } from "../src/data/memory-store"
import { FeedImporter } from "../src/feeds/importer"
import { refreshSubscribedFeeds } from "../src/feeds/scheduler"

const fixturePath = fileURLToPath(new URL("fixtures/phase-one.rss.xml", import.meta.url))

describe("feed polling", () => {
  it("supports a feed_supplier provider at the importer boundary", () => {
    const importer = new FeedImporter(new MemoryDataStore(), {
      providerId: "feed_supplier",
      fetch: async () => {
        throw new Error("The external provider is supplied by a future adapter")
      },
    })

    expect(importer.providerId).toBe("feed_supplier")
  })

  it("refreshes a shared subscribed feed only once per polling cycle", async () => {
    const dataStore = new MemoryDataStore()
    const feedXML = await readFile(fixturePath, "utf8")
    let fetchCount = 0
    const importer = new FeedImporter(dataStore, {
      fetch: async (url) => {
        fetchCount += 1
        return {
          body: feedXML,
          contentType: "application/rss+xml",
          etag: null,
          lastModified: null,
          url,
        }
      },
    })
    const imported = await importer.subscribe("user-1", {
      url: "https://feeds.example.com/rss.xml",
      view: 0,
    })
    await dataStore.createSubscription({
      ...imported.subscription,
      userId: "user-2",
    })

    const result = await refreshSubscribedFeeds(dataStore, importer, {
      now: imported.feed.nextFetchAt,
    })

    expect(fetchCount).toBe(2)
    expect(result).toMatchObject({ deferred: 0, failed: 0, refreshed: 1 })
  })

  it("keeps the subscribed feed identity when a redirect target changes", async () => {
    const dataStore = new MemoryDataStore()
    const feedXML = await readFile(fixturePath, "utf8")
    let responseBody = feedXML
    let responseURL = "https://cdn.example.com/current.xml"
    const importer = new FeedImporter(dataStore, {
      fetch: async () => ({
        body: responseBody,
        contentType: "application/rss+xml",
        etag: null,
        lastModified: null,
        url: responseURL,
      }),
    })
    const imported = await importer.subscribe("user-1", {
      url: "https://feeds.example.com/rss.xml",
      view: 0,
    })

    responseURL = "https://new-cdn.example.com/current.xml"
    responseBody = feedXML.replace(
      "</channel>",
      `<item>
        <guid isPermaLink="false">redirected-entry-3</guid>
        <title>Redirected third entry</title>
        <pubDate>Sat, 16 Aug 2026 03:00:00 GMT</pubDate>
      </item></channel>`,
    )
    await importer.refresh(imported.feed)

    expect(await dataStore.listEntries({ userId: "user-1", limit: 20 })).toHaveLength(3)
    expect((await dataStore.listSubscriptions("user-1"))[0]?.feedId).toBe(imported.feed.id)
  })

  it("defers a failed feed until its exponential backoff expires and records bounded diagnostics", async () => {
    const dataStore = new MemoryDataStore()
    const feedXML = await readFile(fixturePath, "utf8")
    let failRefresh = false
    const importer = new FeedImporter(
      dataStore,
      {
        fetch: async (url) => {
          if (failRefresh) {
            const error = new Error("upstream token=secret must not leak forever")
            error.name = "TimeoutError"
            throw error
          }
          return {
            body: feedXML,
            contentType: "application/rss+xml",
            etag: '"feed-v1"',
            lastModified: "Tue, 18 Aug 2026 00:00:00 GMT",
            status: 200,
            url,
          }
        },
      },
      undefined,
      { refreshIntervalMs: 60_000, retryBaseDelayMs: 1_000 },
    )
    const imported = await importer.subscribe("user-1", {
      url: "https://feeds.example.com/backoff.xml",
    })
    const dueAt = new Date(imported.feed.nextFetchAt.getTime() + 1)
    failRefresh = true

    const failed = await refreshSubscribedFeeds(dataStore, importer, { now: dueAt })
    const feed = await dataStore.getFeed(imported.feed.id)

    expect(failed).toMatchObject({ deferred: 0, failed: 1, refreshed: 0 })
    expect(failed.errors).toEqual([
      expect.objectContaining({ feedId: imported.feed.id, summary: expect.any(String) }),
    ])
    expect(feed).toMatchObject({ consecutiveFailures: 1 })
    expect(feed!.nextFetchAt.getTime()).toBe(dueAt.getTime() + 1_000)

    const deferred = await refreshSubscribedFeeds(dataStore, importer, {
      now: new Date(dueAt.getTime() + 999),
    })
    expect(deferred).toMatchObject({ deferred: 1, failed: 0, refreshed: 0 })

    const diagnostics = await dataStore.listFeedFetchAttempts(imported.feed.id, 20)
    expect(diagnostics.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"])
    expect(diagnostics[0]).toMatchObject({
      errorCode: "feed_fetch_timeout",
      errorSummary: expect.stringContaining("upstream token=secret"),
    })
    expect("responseBody" in diagnostics[0]!).toBe(false)
  })

  it("treats HTTP 304 as a successful refresh without replacing entries", async () => {
    const dataStore = new MemoryDataStore()
    const feedXML = await readFile(fixturePath, "utf8")
    const requests: Array<{ etag?: string | null; lastModified?: string | null }> = []
    let subscribed = false
    const importer = new FeedImporter(dataStore, {
      fetch: async (url, options) => {
        requests.push(options ?? {})
        if (subscribed) {
          return {
            body: "",
            contentType: null,
            etag: '"feed-v1"',
            lastModified: "Tue, 18 Aug 2026 00:00:00 GMT",
            notModified: true,
            status: 304,
            url,
          }
        }
        subscribed = true
        return {
          body: feedXML,
          contentType: "application/rss+xml",
          etag: '"feed-v1"',
          lastModified: "Tue, 18 Aug 2026 00:00:00 GMT",
          status: 200,
          url,
        }
      },
    })
    const imported = await importer.subscribe("user-1", {
      url: "https://feeds.example.com/conditional.xml",
    })

    const refreshed = await importer.refresh(imported.feed)

    expect(refreshed.notModified).toBe(true)
    expect(requests[1]).toEqual({
      etag: '"feed-v1"',
      lastModified: "Tue, 18 Aug 2026 00:00:00 GMT",
    })
    expect(await dataStore.listEntries({ userId: "user-1", limit: 20 })).toHaveLength(2)
    expect((await dataStore.getFeed(imported.feed.id))?.consecutiveFailures).toBe(0)
  })

  it("bounds concurrent polling work", async () => {
    const dataStore = new MemoryDataStore()
    const feedXML = await readFile(fixturePath, "utf8")
    let active = 0
    let maximumActive = 0
    let polling = false
    const importer = new FeedImporter(dataStore, {
      fetch: async (url) => {
        if (polling) {
          active += 1
          maximumActive = Math.max(maximumActive, active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active -= 1
        }
        return {
          body: feedXML,
          contentType: "application/rss+xml",
          etag: null,
          lastModified: null,
          status: 200,
          url,
        }
      },
    })
    const subscriptions = []
    for (let index = 0; index < 6; index += 1) {
      subscriptions.push(
        await importer.subscribe("user-1", {
          url: `https://feeds.example.com/concurrency-${index}.xml`,
        }),
      )
    }
    polling = true

    const result = await refreshSubscribedFeeds(dataStore, importer, {
      concurrency: 2,
      now: new Date(Math.max(...subscriptions.map((item) => item.feed.nextFetchAt.getTime()))),
    })

    expect(result.refreshed).toBe(6)
    expect(maximumActive).toBe(2)
  })
})
