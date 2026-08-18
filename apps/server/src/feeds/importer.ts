import type { DataStore, FeedRecord, SubscriptionRecord } from "../data/types"
import { parseFeed } from "./parser"

export interface FetchedFeed {
  body: string
  contentType: string | null
  etag: string | null
  lastModified: string | null
  url: string
}

export interface FeedFetcher {
  fetch(url: string): Promise<FetchedFeed>
}

export interface SubscribeInput {
  url: string
  view?: number
  category?: string | null
  isPrivate?: boolean
  title?: string | null
}

export interface ImportedEntriesContext {
  entries: Awaited<ReturnType<typeof parseFeed>>["entries"]
  feed: Awaited<ReturnType<typeof parseFeed>>["feed"]
  userId: string | null
}

export class FeedImporter {
  constructor(
    private readonly dataStore: DataStore,
    private readonly feedFetcher: FeedFetcher,
    private readonly onEntriesImported?: (context: ImportedEntriesContext) => Promise<void>,
  ) {}

  async preview(url: string) {
    const fetched = await this.feedFetcher.fetch(url)
    const parsed = parseFeed(fetched.body, fetched.url)
    parsed.feed.etag = fetched.etag
    parsed.feed.lastModified = fetched.lastModified
    return parsed
  }

  async subscribe(userId: string, input: SubscribeInput) {
    const parsed = await this.preview(input.url)

    const subscription: SubscriptionRecord = {
      userId,
      feedId: parsed.feed.id,
      view: input.view ?? 0,
      category: input.category ?? null,
      title: input.title ?? null,
      isPrivate: input.isPrivate ?? false,
      hideFromTimeline: null,
      createdAt: new Date(),
    }

    await this.dataStore.saveFeed(parsed.feed, parsed.entries)
    await this.dataStore.createSubscription(subscription)
    await this.onEntriesImported?.({ entries: parsed.entries, feed: parsed.feed, userId })

    return { ...parsed, subscription }
  }

  async refresh(feed: FeedRecord) {
    const fetched = await this.feedFetcher.fetch(feed.url)
    const parsed = parseFeed(fetched.body, fetched.url, new Date(), feed.url)
    parsed.feed.ownerUserId = feed.ownerUserId
    parsed.feed.etag = fetched.etag
    parsed.feed.lastModified = fetched.lastModified
    await this.dataStore.saveFeed(parsed.feed, parsed.entries)
    await this.onEntriesImported?.({ entries: parsed.entries, feed: parsed.feed, userId: null })
    return parsed
  }
}
