import { Button } from "@follow/components/ui/button/index.js"
import { cn } from "@follow/utils/utils"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { useAdvertisedCapability } from "~/atoms/capabilities"

import { getEntryAIStatusModel } from "../presentation"
import { useAIProcessingMutations, useEntryEvaluation, useEntryProjections } from "../queries"
import { useEntryProjection } from "../state"

const ScoreDimension = ({ label, value }: { label: string; value: number }) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-text-secondary">{label}</span>
      <span className="font-medium tabular-nums text-text">{value}</span>
    </div>
    <div className="h-1.5 overflow-hidden rounded-full bg-fill-secondary">
      <div
        className="h-full rounded-full bg-accent transition-transform duration-300 f-motion-reduce:transition-none"
        style={{ transform: `translateX(-${100 - value}%)` }}
      />
    </div>
  </div>
)

export const EntryEvaluationPanel = ({ entryId }: { entryId: string }) => {
  const { t } = useTranslation()
  const enabled = useAdvertisedCapability("entries.ai_fusion")
  useEntryProjections([entryId], enabled)
  const projection = useEntryProjection(entryId)
  const model = getEntryAIStatusModel(projection)
  const evaluationQuery = useEntryEvaluation(entryId, enabled)
  const mutations = useAIProcessingMutations()
  const current = evaluationQuery.data?.current ?? projection?.evaluation ?? null
  const history = evaluationQuery.data?.history ?? []

  if (!enabled) return null

  const run = async (forceRerun = false) => {
    try {
      await mutations.createJob.mutateAsync({ entryId, forceRerun })
      toast.success(t("ai_processing.entry.queued"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("ai_processing.request_failed"))
    }
  }
  const retry = async () => {
    if (!model.jobId) return
    try {
      await mutations.retryJob.mutateAsync(model.jobId)
      toast.success(t("ai_processing.entry.retry_queued"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("ai_processing.request_failed"))
    }
  }

  return (
    <section
      className="my-6 overflow-hidden rounded-xl border border-fill-secondary bg-material-ultra-thin shadow-sm"
      aria-label={t("ai_processing.entry.title")}
      data-testid="entry-evaluation-panel"
    >
      <div className="flex flex-wrap items-center gap-4 p-4">
        {current ? (
          <>
            <div className="flex size-16 shrink-0 flex-col items-center justify-center rounded-full border border-accent/30 bg-accent/10">
              <span className="text-2xl font-semibold tabular-nums text-text">
                {current.overall_score}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-text-secondary">
                {t("ai_processing.score")}
              </span>
            </div>
            <div className="min-w-[12rem] flex-1 space-y-2">
              <ScoreDimension
                label={t("ai_processing.importance_score")}
                value={current.importance_score}
              />
              <ScoreDimension
                label={t("ai_processing.timeliness_score")}
                value={current.timeliness_score}
              />
              <ScoreDimension
                label={t("ai_processing.relevance_score")}
                value={current.relevance_score}
              />
            </div>
          </>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-fill-secondary">
              <i className="i-mgc-ai-cute-re size-5 text-text-secondary" />
            </div>
            <div>
              <div className="text-sm font-medium text-text">
                {t("ai_processing.entry.empty_title")}
              </div>
              <div className="text-xs text-text-secondary">
                {t("ai_processing.entry.empty_description")}
              </div>
            </div>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {model.status === "failed" && model.jobId ? (
            <Button size="sm" disabled={mutations.retryJob.isPending} onClick={retry}>
              <i className="i-mgc-refresh-3-cute-re mr-1.5 size-4" />
              {t("ai_processing.entry.retry")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant={current ? "outline" : "primary"}
              disabled={
                mutations.createJob.isPending ||
                model.status === "queued" ||
                model.status === "running"
              }
              onClick={() => run(!!current)}
            >
              <i
                className={cn(
                  "mr-1.5 size-4",
                  model.status === "queued" || model.status === "running"
                    ? "i-mgc-loading-3-cute-re animate-spin f-motion-reduce:animate-none"
                    : "i-mgc-sparkles-2-cute-re",
                )}
              />
              {model.status === "queued" || model.status === "running"
                ? t(`ai_processing.status.${model.status}`)
                : current
                  ? t("ai_processing.entry.reevaluate")
                  : t("ai_processing.entry.evaluate")}
            </Button>
          )}
        </div>
      </div>

      {model.status === "failed" && (
        <div className="flex items-start gap-2 border-t border-red/20 bg-red/5 px-4 py-3 text-xs text-red">
          <i className="i-mgc-warning-cute-re mt-0.5 size-4 shrink-0" />
          <span>{model.errorSummary ?? t("ai_processing.entry.failed")}</span>
        </div>
      )}

      {current && (
        <div className="space-y-3 border-t border-fill-secondary px-4 py-3">
          {current.configuration_outdated && (
            <div className="flex items-center gap-2 rounded-lg border border-orange/30 bg-orange/5 px-3 py-2 text-xs text-orange">
              <i className="i-mgc-history-cute-re size-4" />
              {t("ai_processing.configuration_outdated_description")}
            </div>
          )}
          <p className="text-sm leading-relaxed text-text">{current.recommendation_reason}</p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded-md bg-fill-secondary px-2 py-1 text-text">
              {current.primary_category}
              {current.secondary_category ? ` / ${current.secondary_category}` : ""}
            </span>
            {current.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-md bg-fill-quaternary px-2 py-1 text-text-secondary"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {history.length > 1 && (
        <details className="border-t border-fill-secondary px-4 py-3">
          <summary className="cursor-pointer text-xs font-medium text-text-secondary">
            {t("ai_processing.entry.history", { count: history.length })}
          </summary>
          <div className="mt-3 space-y-2">
            {history.map((evaluation) => {
              const selected = current?.id === evaluation.id
              return (
                <div
                  key={evaluation.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg bg-fill-quaternary px-3 py-2 text-xs"
                >
                  <span className="font-semibold tabular-nums text-text">
                    {evaluation.overall_score}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text-secondary">
                    {evaluation.primary_category} ·{" "}
                    {new Date(evaluation.processed_at).toLocaleString()}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={selected || mutations.selectEvaluation.isPending}
                    onClick={async () => {
                      try {
                        await mutations.selectEvaluation.mutateAsync({
                          entryId,
                          evaluationId: evaluation.id,
                        })
                        toast.success(t("ai_processing.entry.rollback_success"))
                      } catch (error) {
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : t("ai_processing.request_failed"),
                        )
                      }
                    }}
                  >
                    {selected ? t("ai_processing.entry.current") : t("ai_processing.entry.select")}
                  </Button>
                </div>
              )
            })}
          </div>
        </details>
      )}
    </section>
  )
}
