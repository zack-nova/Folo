import type { DataStore } from "../data/types"
import type { FeedImporter } from "./importer"

export interface RefreshCycleResult {
  failed: number
  refreshed: number
}

export const refreshSubscribedFeeds = async (
  dataStore: DataStore,
  importer: FeedImporter,
): Promise<RefreshCycleResult> => {
  const feeds = await dataStore.listSubscribedFeeds()
  const results = await Promise.allSettled(feeds.map((feed) => importer.refresh(feed)))
  return {
    failed: results.filter((result) => result.status === "rejected").length,
    refreshed: results.filter((result) => result.status === "fulfilled").length,
  }
}

export const startFeedScheduler = ({
  dataStore,
  importer,
  intervalMs,
  onResult,
}: {
  dataStore: DataStore
  importer: FeedImporter
  intervalMs: number
  onResult?: (result: RefreshCycleResult) => void
}) => {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      onResult?.(await refreshSubscribedFeeds(dataStore, importer))
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
