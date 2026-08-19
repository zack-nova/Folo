import { bench, describe } from "vitest"

import { MemoryDataStore } from "../src/data/memory-store"
import type { EntryRecord, FeedRecord } from "../src/data/types"

const dataStore = new MemoryDataStore()
const entryIds = Array.from({ length: 100 }, (_, index) => `entry-${index}`)
const timestamp = new Date("2026-08-18T00:00:00.000Z")
const feed: FeedRecord = {
  consecutiveFailures: 0,
  description: null,
  errorAt: null,
  errorMessage: null,
  etag: null,
  fetchedAt: timestamp,
  id: "feed-benchmark",
  image: null,
  lastModified: null,
  lastSuccessAt: timestamp,
  nextFetchAt: timestamp,
  ownerUserId: null,
  siteUrl: null,
  title: "Benchmark",
  url: "https://feeds.example.com/benchmark.xml",
}
const entries: EntryRecord[] = Array.from({ length: 10_000 }, (_, index) => ({
  attachments: null,
  author: null,
  authorAvatar: null,
  authorUrl: null,
  categories: null,
  content: `Content ${index}`,
  description: null,
  extra: null,
  feedId: feed.id,
  guid: `guid-${index}`,
  id: `entry-${index}`,
  insertedAt: timestamp,
  language: "en",
  media: null,
  publishedAt: new Date(timestamp.getTime() - index * 1_000),
  title: `Entry ${index}`,
  url: `https://example.com/${index}`,
}))
await dataStore.saveFeed(feed, entries)
await dataStore.createSubscription({
  category: null,
  createdAt: timestamp,
  feedId: feed.id,
  hideFromTimeline: null,
  isPrivate: false,
  title: null,
  userId: "benchmark-user",
  view: 0,
})

describe("stage four large timeline", () => {
  bench("lists one page from 10,000 entries", async () => {
    await dataStore.listEntries({ limit: 100, userId: "benchmark-user", view: 0 })
  })

  bench("loads 100 entry projections in one batch", async () => {
    await dataStore.getEntryProjections("benchmark-user", entryIds)
  })
})
