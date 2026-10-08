import type { ProcessingJob, ProcessingJobStatus } from "~/modules/ai-processing/types"

export type FeedFailure = {
  consecutive_failures: number
  feed_id: string
  last_error_at: string | null
  last_error_summary: string | null
  next_fetch_at: string
  title: string | null
  url: string
}

export type FeedFetchDiagnostic = {
  duration_ms: number
  entry_count: number | null
  error_code: string | null
  error_summary: string | null
  finished_at: string
  http_status: number | null
  id: string
  response_url: string | null
  started_at: string
  status: "failed" | "not_modified" | "succeeded"
}

export type OperationsStatus = {
  alerts: Array<{
    code:
      | "feed_acquisition_degraded"
      | "official_account_auth_invalid"
      | "official_bindings_failed"
      | "processing_jobs_failed"
      | "source_provider_unavailable"
    count: number
    provider?: "folo_official" | "page_change" | "rsshub" | "web_list"
    severity: "critical" | "warning"
  }>
  failed_processing_jobs: ProcessingJob[]
  feed_failures: FeedFailure[]
  last_cleanup: {
    at: string
    report: {
      diagnosticPayloadsCleared: number
      entryEvaluationsDeleted: number
      feedFetchAttemptsDeleted: number
      processingAttemptsDeleted: number
      processingJobsDeleted: number
    }
  } | null
  last_feed_polling_cycle: {
    at: string
    result: {
      deferred: number
      errors: Array<{ feedId: string; summary: string }>
      failed: number
      refreshed: number
    }
  } | null
  source_providers: Array<{
    activeRequestCount?: number
    cacheHitCount?: number
    cacheMissCount?: number
    cacheStatus?: "ready" | "unavailable"
    catalogRouteCount?: number
    coalescedRequestCount?: number
    concurrencyRejectedRequestCount?: number
    configured: boolean
    dueSourceCount?: number
    enabledSourceCount?: number
    id: "folo_official" | "page_change" | "rsshub" | "web_list"
    lastCycleAt?: string | null
    managedRouteCount?: number
    message: string | null
    officialAccountStatus?: "active" | "auth_invalid" | "unlinked"
    activeBindingCount?: number
    failedBindingCount?: number
    persistenceStatus?: "ready" | "unavailable"
    rateLimitedRequestCount?: number
    registryMode?: "managed_only" | "permissive"
    status: "disabled" | "ready" | "unavailable"
  }>
  stats: {
    feedAcquisitionFailures: number
    feedsDue: number
    processingJobs: Record<ProcessingJobStatus, number>
    subscribedFeeds: number
  }
  status: "degraded" | "healthy"
}

export type FeedDiagnostics = {
  items: FeedFetchDiagnostic[]
  limit: number
}
