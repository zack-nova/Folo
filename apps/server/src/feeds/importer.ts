import { randomUUID } from "node:crypto"

import type {
  DataStore,
  FeedFetchAttemptRecord,
  FeedRecord,
  SubscriptionRecord,
} from "../data/types"
import { parseFeed } from "./parser"

export interface FetchedFeed {
  body: string
  contentType: string | null
  etag: string | null
  lastModified: string | null
  url: string
  notModified?: boolean
  status?: number
}

export type FeedAcquisitionProviderId = "feed_supplier" | "standard_rss"

export interface FeedFetcher {
  readonly providerId?: FeedAcquisitionProviderId
  fetch(
    url: string,
    options?: { etag?: string | null; lastModified?: string | null },
  ): Promise<FetchedFeed>
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

export interface FeedImporterOptions {
  refreshIntervalMs?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
}

const acquisitionError = (error: unknown) => ({
  code:
    error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
      ? "feed_fetch_timeout"
      : "feed_fetch_failed",
  summary: (error instanceof Error ? error.message : "Feed fetch failed").slice(0, 500),
})

const attemptId = () => `feed_attempt_${randomUUID().replaceAll("-", "")}`

export class FeedImporter {
  readonly providerId: FeedAcquisitionProviderId
  private readonly refreshIntervalMs: number
  private readonly retryBaseDelayMs: number
  private readonly retryMaxDelayMs: number

  constructor(
    private readonly dataStore: DataStore,
    private readonly feedFetcher: FeedFetcher,
    private readonly onEntriesImported?: (context: ImportedEntriesContext) => Promise<void>,
    options: FeedImporterOptions = {},
  ) {
    this.providerId = feedFetcher.providerId ?? "standard_rss"
    this.refreshIntervalMs = options.refreshIntervalMs ?? 15 * 60 * 1_000
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 60 * 1_000
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 24 * 60 * 60 * 1_000
  }

  async preview(url: string) {
    const fetched = await this.feedFetcher.fetch(url)
    if (fetched.notModified) throw new Error("Feed preview unexpectedly returned HTTP 304")
    const parsed = parseFeed(fetched.body, fetched.url)
    parsed.feed.etag = fetched.etag
    parsed.feed.lastModified = fetched.lastModified
    return parsed
  }

  async subscribe(userId: string, input: SubscribeInput) {
    const parsed = await this.preview(input.url)
    parsed.feed.lastSuccessAt = parsed.feed.fetchedAt
    parsed.feed.nextFetchAt = new Date(parsed.feed.fetchedAt.getTime() + this.refreshIntervalMs)

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

    await this.dataStore.saveFeed(parsed.feed, parsed.entries, {
      durationMs: 0,
      entryCount: parsed.entries.length,
      errorCode: null,
      errorSummary: null,
      feedId: parsed.feed.id,
      finishedAt: parsed.feed.fetchedAt,
      httpStatus: 200,
      id: attemptId(),
      responseUrl: parsed.feed.url,
      startedAt: parsed.feed.fetchedAt,
      status: "succeeded",
    })
    await this.dataStore.createSubscription(subscription)
    await this.onEntriesImported?.({ entries: parsed.entries, feed: parsed.feed, userId })

    return { ...parsed, subscription }
  }

  async refresh(feed: FeedRecord, options: { now?: Date } = {}) {
    const startedAt = options.now ?? new Date()
    try {
      const fetched = await this.feedFetcher.fetch(feed.url, {
        etag: feed.etag,
        lastModified: feed.lastModified,
      })
      const finishedAt = options.now ?? new Date()
      const attemptBase = {
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        errorCode: null,
        errorSummary: null,
        feedId: feed.id,
        finishedAt,
        httpStatus: fetched.status ?? (fetched.notModified ? 304 : 200),
        id: attemptId(),
        responseUrl: fetched.url,
        startedAt,
      } satisfies Omit<FeedFetchAttemptRecord, "entryCount" | "status">

      if (fetched.notModified) {
        const refreshedFeed: FeedRecord = {
          ...feed,
          consecutiveFailures: 0,
          errorAt: null,
          errorMessage: null,
          etag: fetched.etag ?? feed.etag,
          fetchedAt: finishedAt,
          lastModified: fetched.lastModified ?? feed.lastModified,
          lastSuccessAt: finishedAt,
          nextFetchAt: new Date(finishedAt.getTime() + this.refreshIntervalMs),
        }
        await this.dataStore.saveFeed(refreshedFeed, [], {
          ...attemptBase,
          entryCount: 0,
          status: "not_modified",
        })
        return { entries: [], feed: refreshedFeed, notModified: true as const }
      }

      const parsed = parseFeed(fetched.body, fetched.url, finishedAt, feed.url)
      parsed.feed.ownerUserId = feed.ownerUserId
      parsed.feed.etag = fetched.etag
      parsed.feed.lastModified = fetched.lastModified
      parsed.feed.consecutiveFailures = 0
      parsed.feed.lastSuccessAt = finishedAt
      parsed.feed.nextFetchAt = new Date(finishedAt.getTime() + this.refreshIntervalMs)
      await this.dataStore.saveFeed(parsed.feed, parsed.entries, {
        ...attemptBase,
        entryCount: parsed.entries.length,
        status: "succeeded",
      })
      await this.onEntriesImported?.({ entries: parsed.entries, feed: parsed.feed, userId: null })
      return { ...parsed, notModified: false as const }
    } catch (error) {
      const finishedAt = options.now ?? new Date()
      const failure = acquisitionError(error)
      const consecutiveFailures = feed.consecutiveFailures + 1
      const retryDelay = Math.min(
        this.retryBaseDelayMs * 2 ** (consecutiveFailures - 1),
        this.retryMaxDelayMs,
      )
      await this.dataStore.saveFeed(
        {
          ...feed,
          consecutiveFailures,
          errorAt: finishedAt,
          errorMessage: failure.summary,
          fetchedAt: finishedAt,
          nextFetchAt: new Date(finishedAt.getTime() + retryDelay),
        },
        [],
        {
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          entryCount: null,
          errorCode: failure.code,
          errorSummary: failure.summary,
          feedId: feed.id,
          finishedAt,
          httpStatus: null,
          id: attemptId(),
          responseUrl: null,
          startedAt,
          status: "failed",
        },
      )
      throw error
    }
  }
}
