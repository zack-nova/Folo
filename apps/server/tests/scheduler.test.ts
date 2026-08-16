import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { MemoryDataStore } from "../src/data/memory-store"
import { FeedImporter } from "../src/feeds/importer"
import { refreshSubscribedFeeds } from "../src/feeds/scheduler"

const fixturePath = fileURLToPath(new URL("fixtures/phase-one.rss.xml", import.meta.url))

describe("feed polling", () => {
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

    const result = await refreshSubscribedFeeds(dataStore, importer)

    expect(fetchCount).toBe(2)
    expect(result).toEqual({ failed: 0, refreshed: 1 })
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
})
