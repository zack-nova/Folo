import { Button } from "@follow/components/ui/button/index.js"
import { cn } from "@follow/utils"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import type { FeedFailure, FeedFetchDiagnostic, OperationsStatus } from "~/modules/operations"
import {
  useFeedDiagnostics,
  useOperationsMutations,
  useOperationsStatus,
} from "~/modules/operations"

const formattedDate = (value: string | null | undefined, language: string) => {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Operations request failed"

const SectionHeading = ({ description, title }: { description: string; title: string }) => (
  <div>
    <h2 className="text-sm font-semibold text-text">{title}</h2>
    <p className="mt-1 text-xs leading-relaxed text-text-secondary">{description}</p>
  </div>
)

const MetricCard = ({
  icon,
  label,
  tone = "neutral",
  value,
}: {
  icon: string
  label: string
  tone?: "danger" | "neutral" | "warning"
  value: number
}) => (
  <div className="rounded-xl border border-fill-secondary bg-fill-quinary p-4">
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      <i
        aria-hidden
        className={cn(
          icon,
          "size-4",
          tone === "danger" && "text-red",
          tone === "warning" && "text-orange",
          tone === "neutral" && "text-text-secondary",
        )}
      />
    </div>
    <div className="mt-3 font-mono text-2xl font-semibold tabular-nums text-text">{value}</div>
  </div>
)

const DiagnosticRow = ({
  diagnostic,
  language,
}: {
  diagnostic: FeedFetchDiagnostic
  language: string
}) => {
  const successful = diagnostic.status !== "failed"
  return (
    <li className="grid gap-2 border-t border-fill-secondary py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-xs font-medium",
              successful ? "text-green" : "text-red",
            )}
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            {diagnostic.status}
          </span>
          {diagnostic.http_status !== null && (
            <span className="font-mono text-xs text-text-secondary">
              HTTP {diagnostic.http_status}
            </span>
          )}
          <span className="font-mono text-xs tabular-nums text-text-secondary">
            {diagnostic.duration_ms} ms
          </span>
        </div>
        {(diagnostic.error_summary || diagnostic.response_url) && (
          <p className="mt-1 break-all text-xs leading-relaxed text-text-secondary">
            {diagnostic.error_summary ?? diagnostic.response_url}
          </p>
        )}
      </div>
      <time className="text-xs tabular-nums text-text-tertiary">
        {formattedDate(diagnostic.finished_at, language)}
      </time>
    </li>
  )
}

const FeedFailureCard = ({
  expanded,
  feed,
  language,
  onExpand,
  onRetry,
  retrying,
}: {
  expanded: boolean
  feed: FeedFailure
  language: string
  onExpand: () => void
  onRetry: () => void
  retrying: boolean
}) => {
  const { t } = useTranslation("settings")
  const diagnostics = useFeedDiagnostics(expanded ? feed.feed_id : null)

  return (
    <article
      className="rounded-xl border border-orange/25 bg-orange/5 p-4"
      data-testid={`operations-feed-failure-${feed.feed_id}`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium text-text">{feed.title ?? feed.url}</h3>
            <span className="rounded-full bg-orange/10 px-2 py-0.5 text-xs font-medium text-orange">
              {t("operations.feed.failure_count", { count: feed.consecutive_failures })}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-text-tertiary" title={feed.url}>
            {feed.url}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-text-secondary">
            {feed.last_error_summary ?? t("operations.error_unknown")}
          </p>
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-secondary">
            <div className="flex gap-1.5">
              <dt>{t("operations.feed.last_error")}</dt>
              <dd className="tabular-nums">{formattedDate(feed.last_error_at, language)}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>{t("operations.feed.next_fetch")}</dt>
              <dd className="tabular-nums">{formattedDate(feed.next_fetch_at, language)}</dd>
            </div>
          </dl>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid={`operations-diagnostics-toggle-${feed.feed_id}`}
            onClick={onExpand}
          >
            {expanded ? t("operations.hide_diagnostics") : t("operations.show_diagnostics")}
          </Button>
          <Button
            size="sm"
            data-testid={`operations-retry-feed-${feed.feed_id}`}
            isLoading={retrying}
            onClick={onRetry}
          >
            {t("operations.retry_feed")}
          </Button>
        </div>
      </div>

      {expanded && (
        <div
          className="mt-4 border-t border-orange/20 pt-3"
          data-testid={`operations-diagnostics-${feed.feed_id}`}
        >
          {diagnostics.isLoading && (
            <div className="flex min-h-16 items-center justify-center text-text-secondary">
              <i className="i-mgc-loading-3-cute-re size-4 animate-spin f-motion-reduce:animate-none" />
            </div>
          )}
          {diagnostics.isError && (
            <p role="alert" className="text-xs text-red">
              {diagnostics.error.message}
            </p>
          )}
          {diagnostics.data && diagnostics.data.items.length === 0 && (
            <p className="py-3 text-xs text-text-secondary">{t("operations.diagnostics_empty")}</p>
          )}
          {diagnostics.data && diagnostics.data.items.length > 0 && (
            <ul aria-label={t("operations.diagnostics_title")}>
              {diagnostics.data.items.map((diagnostic) => (
                <DiagnosticRow key={diagnostic.id} diagnostic={diagnostic} language={language} />
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  )
}

const RuntimeActivity = ({ language, status }: { language: string; status: OperationsStatus }) => {
  const { t } = useTranslation("settings")
  const polling = status.last_feed_polling_cycle
  const cleanup = status.last_cleanup
  const cleaned = cleanup
    ? Object.values(cleanup.report).reduce((total, count) => total + count, 0)
    : 0

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-fill-secondary p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-text">
          <i className="i-mgc-radar-2-cute-re size-4 text-text-secondary" aria-hidden />
          {t("operations.polling.title")}
        </div>
        {polling ? (
          <>
            <p className="mt-2 text-xs tabular-nums text-text-secondary">
              {formattedDate(polling.at, language)}
            </p>
            <div className="mt-3 flex flex-wrap gap-3 font-mono text-xs tabular-nums text-text-secondary">
              <span>{t("operations.polling.refreshed", { count: polling.result.refreshed })}</span>
              <span>{t("operations.polling.failed", { count: polling.result.failed })}</span>
              <span>{t("operations.polling.deferred", { count: polling.result.deferred })}</span>
            </div>
          </>
        ) : (
          <p className="mt-2 text-xs text-text-secondary">{t("operations.activity_empty")}</p>
        )}
      </div>
      <div className="rounded-xl border border-fill-secondary p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-text">
          <i className="i-mgc-broom-cute-re size-4 text-text-secondary" aria-hidden />
          {t("operations.cleanup.title")}
        </div>
        {cleanup ? (
          <>
            <p className="mt-2 text-xs tabular-nums text-text-secondary">
              {formattedDate(cleanup.at, language)}
            </p>
            <p className="mt-3 font-mono text-xs tabular-nums text-text-secondary">
              {t("operations.cleanup.total", { count: cleaned })}
            </p>
          </>
        ) : (
          <p className="mt-2 text-xs text-text-secondary">{t("operations.activity_empty")}</p>
        )}
      </div>
    </div>
  )
}

const SourceProviders = ({ providers }: { providers: OperationsStatus["source_providers"] }) => {
  const { t } = useTranslation("settings")

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {providers.map((provider) => (
        <article
          key={provider.id}
          className="rounded-xl border border-fill-secondary p-4"
          data-testid={`operations-source-provider-${provider.id}`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-text">
              <i className="i-mgc-rss-2-cute-re size-4 text-text-secondary" aria-hidden />
              {t(`operations.sources.${provider.id}.title`)}
            </div>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 text-xs font-medium",
                provider.status === "ready" && "text-green",
                provider.status === "unavailable" && "text-red",
                provider.status === "disabled" && "text-text-tertiary",
              )}
            >
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              {t(`operations.sources.status.${provider.status}`)}
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-text-secondary">
            {provider.message ?? t(`operations.sources.${provider.id}.${provider.status}`)}
          </p>
          {provider.managedRouteCount !== undefined && (
            <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-fill-secondary pt-3 text-xs text-text-secondary">
              <div className="flex gap-1.5">
                <dt>{t("operations.sources.managed_routes")}</dt>
                <dd className="font-mono tabular-nums">{provider.managedRouteCount}</dd>
              </div>
              {provider.registryMode && (
                <div className="flex gap-1.5">
                  <dt>{t("operations.sources.registry_mode")}</dt>
                  <dd>{t(`operations.sources.mode.${provider.registryMode}`)}</dd>
                </div>
              )}
              {provider.persistenceStatus && (
                <div className="flex gap-1.5">
                  <dt>{t("operations.sources.persistence")}</dt>
                  <dd>{t(`operations.sources.status.${provider.persistenceStatus}`)}</dd>
                </div>
              )}
            </dl>
          )}
        </article>
      ))}
    </div>
  )
}

export const SettingOperations = () => {
  const { i18n, t } = useTranslation("settings")
  const statusQuery = useOperationsStatus()
  const mutations = useOperationsMutations()
  const [expandedFeedId, setExpandedFeedId] = useState<string | null>(null)

  if (statusQuery.isLoading) {
    return (
      <div
        className="flex min-h-48 items-center justify-center text-text-secondary"
        data-testid="operations-settings"
      >
        <i className="i-mgc-loading-3-cute-re size-5 animate-spin f-motion-reduce:animate-none" />
      </div>
    )
  }

  if (statusQuery.isError || !statusQuery.data) {
    return (
      <div className="mt-4" data-testid="operations-settings">
        <div role="alert" className="rounded-xl border border-red/30 bg-red/5 p-4">
          <h2 className="text-sm font-semibold text-red">{t("operations.load_failed")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            {statusQuery.error?.message ?? t("operations.error_unknown")}
          </p>
          <Button
            variant="outline"
            size="sm"
            buttonClassName="mt-3"
            onClick={() => void statusQuery.refetch()}
          >
            {t("operations.retry")}
          </Button>
        </div>
      </div>
    )
  }

  const status = statusQuery.data
  const activeJobs = status.stats.processingJobs.queued + status.stats.processingJobs.running
  const degraded = status.status === "degraded"

  const retryFeed = (feedId: string) => {
    mutations.retryFeed.mutate(feedId, {
      onError: (error) => toast.error(errorMessage(error)),
      onSuccess: () => toast.success(t("operations.retry_feed_success")),
    })
  }
  const retryJob = (jobId: string) => {
    mutations.retryProcessingJob.mutate(jobId, {
      onError: (error) => toast.error(errorMessage(error)),
      onSuccess: () => toast.success(t("operations.retry_job_success")),
    })
  }

  return (
    <div className="mt-4 space-y-7 pb-8" data-testid="operations-settings">
      <section
        aria-labelledby="operations-overview-title"
        className={cn(
          "rounded-xl border p-4",
          degraded ? "border-orange/30 bg-orange/5" : "border-green/25 bg-green/5",
        )}
        data-testid="operations-status-banner"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span
                className={cn("size-2 rounded-full", degraded ? "bg-orange" : "bg-green")}
                aria-hidden
              />
              <h2 id="operations-overview-title" className="text-sm font-semibold text-text">
                {degraded ? t("operations.status.degraded") : t("operations.status.healthy")}
              </h2>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              {degraded
                ? t("operations.status.degraded_description")
                : t("operations.status.healthy_description")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            data-testid="operations-refresh"
            isLoading={statusQuery.isFetching}
            onClick={() => void statusQuery.refetch()}
          >
            {t("operations.refresh")}
          </Button>
        </div>
      </section>

      <section aria-labelledby="operations-metrics-title" className="space-y-3">
        <SectionHeading
          title={t("operations.metrics.title")}
          description={t("operations.metrics.description")}
        />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard
            icon="i-mgc-rss-2-cute-re"
            label={t("operations.metrics.subscribed")}
            value={status.stats.subscribedFeeds}
          />
          <MetricCard
            icon="i-mgc-time-cute-re"
            label={t("operations.metrics.due")}
            tone={status.stats.feedsDue > 0 ? "warning" : "neutral"}
            value={status.stats.feedsDue}
          />
          <MetricCard
            icon="i-mgc-warning-cute-re"
            label={t("operations.metrics.feed_failures")}
            tone={status.stats.feedAcquisitionFailures > 0 ? "danger" : "neutral"}
            value={status.stats.feedAcquisitionFailures}
          />
          <MetricCard
            icon="i-mgc-ai-cute-re"
            label={t("operations.metrics.active_jobs")}
            tone={activeJobs > 0 ? "warning" : "neutral"}
            value={activeJobs}
          />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg bg-fill-quinary px-3 py-2 font-mono text-xs tabular-nums text-text-secondary">
          <span>{t("operations.jobs.queued", { count: status.stats.processingJobs.queued })}</span>
          <span>
            {t("operations.jobs.running", { count: status.stats.processingJobs.running })}
          </span>
          <span>{t("operations.jobs.failed", { count: status.stats.processingJobs.failed })}</span>
          <span>
            {t("operations.jobs.succeeded", { count: status.stats.processingJobs.succeeded })}
          </span>
        </div>
      </section>

      <section aria-labelledby="operations-sources-title" className="space-y-3">
        <SectionHeading
          title={t("operations.sources.title")}
          description={t("operations.sources.description")}
        />
        <SourceProviders providers={status.source_providers} />
      </section>

      <section aria-labelledby="operations-feeds-title" className="space-y-3">
        <SectionHeading
          title={t("operations.feed.title")}
          description={t("operations.feed.description")}
        />
        {status.feed_failures.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-fill-secondary p-4 text-sm text-text-secondary">
            <i className="i-mgc-check-circle-cute-re size-5 text-green" aria-hidden />
            {t("operations.feed.empty")}
          </div>
        ) : (
          <div className="space-y-3">
            {status.feed_failures.map((feed) => (
              <FeedFailureCard
                key={feed.feed_id}
                expanded={expandedFeedId === feed.feed_id}
                feed={feed}
                language={i18n.language}
                retrying={
                  mutations.retryFeed.isPending && mutations.retryFeed.variables === feed.feed_id
                }
                onExpand={() =>
                  setExpandedFeedId((current) => (current === feed.feed_id ? null : feed.feed_id))
                }
                onRetry={() => retryFeed(feed.feed_id)}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="operations-jobs-title" className="space-y-3">
        <SectionHeading
          title={t("operations.failed_jobs.title")}
          description={t("operations.failed_jobs.description")}
        />
        {status.failed_processing_jobs.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-fill-secondary p-4 text-sm text-text-secondary">
            <i className="i-mgc-check-circle-cute-re size-5 text-green" aria-hidden />
            {t("operations.failed_jobs.empty")}
          </div>
        ) : (
          <div className="divide-y divide-fill-secondary rounded-xl border border-red/25 bg-red/5 px-4">
            {status.failed_processing_jobs.map((job) => (
              <article
                key={job.id}
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
                data-testid={`operations-failed-job-${job.id}`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-medium text-red">{job.entry_id}</span>
                    <span className="text-xs text-text-tertiary">
                      {t("operations.failed_jobs.attempt", { count: job.attempt_count })}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                    {job.last_error_summary ?? t("operations.error_unknown")}
                  </p>
                  <time className="mt-1 block text-xs tabular-nums text-text-tertiary">
                    {formattedDate(job.finished_at, i18n.language)}
                  </time>
                </div>
                <Button
                  size="sm"
                  data-testid={`operations-retry-job-${job.id}`}
                  isLoading={
                    mutations.retryProcessingJob.isPending &&
                    mutations.retryProcessingJob.variables === job.id
                  }
                  onClick={() => retryJob(job.id)}
                >
                  {t("operations.retry_job")}
                </Button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="operations-activity-title" className="space-y-3">
        <SectionHeading
          title={t("operations.activity.title")}
          description={t("operations.activity.description")}
        />
        <RuntimeActivity language={i18n.language} status={status} />
      </section>
    </div>
  )
}
