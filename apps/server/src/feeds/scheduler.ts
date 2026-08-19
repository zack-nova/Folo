import type { DataStore } from "../data/types"
import type { FeedImporter } from "./importer"

export interface RefreshCycleResult {
  deferred: number
  errors: Array<{ feedId: string; summary: string }>
  failed: number
  refreshed: number
}

export const refreshSubscribedFeeds = async (
  dataStore: DataStore,
  importer: FeedImporter,
  options: { concurrency?: number; now?: Date } = {},
): Promise<RefreshCycleResult> => {
  const feeds = await dataStore.listSubscribedFeeds()
  const now = options.now ?? new Date()
  const dueFeeds = feeds.filter((feed) => feed.nextFetchAt <= now)
  const results: Array<PromiseSettledResult<unknown>> = Array.from({ length: dueFeeds.length })
  let nextIndex = 0
  const concurrency = Math.min(Math.max(Math.trunc(options.concurrency ?? 4), 1), 32)
  await Promise.all(
    Array.from({ length: Math.min(concurrency, dueFeeds.length) }, async () => {
      for (;;) {
        const index = nextIndex
        nextIndex += 1
        const feed = dueFeeds[index]
        if (!feed) return
        try {
          results[index] = { status: "fulfilled", value: await importer.refresh(feed, { now }) }
        } catch (reason) {
          results[index] = { reason, status: "rejected" }
        }
      }
    }),
  )
  return {
    deferred: feeds.length - dueFeeds.length,
    errors: results.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            {
              feedId: dueFeeds[index]!.id,
              summary: (result.reason instanceof Error
                ? result.reason.message
                : "Feed refresh failed"
              ).slice(0, 500),
            },
          ]
        : [],
    ),
    failed: results.filter((result) => result.status === "rejected").length,
    refreshed: results.filter((result) => result.status === "fulfilled").length,
  }
}

export const startFeedScheduler = ({
  dataStore,
  importer,
  intervalMs,
  concurrency,
  onResult,
}: {
  dataStore: DataStore
  importer: FeedImporter
  intervalMs: number
  concurrency?: number
  onResult?: (result: RefreshCycleResult) => void
}) => {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      onResult?.(await refreshSubscribedFeeds(dataStore, importer, { concurrency }))
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
