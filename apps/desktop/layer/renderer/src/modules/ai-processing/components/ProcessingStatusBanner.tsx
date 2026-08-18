import { Button } from "@follow/components/ui/button/index.js"
import { useAtom } from "jotai"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { useAIProcessingMutations } from "../queries"
import { aiEntryFiltersAtom, useEntryProjectionCollection } from "../state"

export const ProcessingStatusBanner = ({ entryIds }: { entryIds: string[] }) => {
  const { t } = useTranslation()
  const projections = useEntryProjectionCollection(entryIds)
  const failures = useMemo(
    () =>
      Object.values(projections).filter(
        (projection) => projection.processing_status?.status === "failed",
      ),
    [projections],
  )
  const [dismissedCount, setDismissedCount] = useState<number | null>(null)
  const [, setFilters] = useAtom(aiEntryFiltersAtom)
  const mutations = useAIProcessingMutations()

  useEffect(() => {
    if (failures.length === 0) setDismissedCount(null)
  }, [failures.length])

  const visible =
    failures.length > 0 && (dismissedCount === null || failures.length > dismissedCount)
  if (!visible) return null

  const retryAll = async () => {
    const jobIds = failures.flatMap((projection) =>
      projection.processing_status?.id ? [projection.processing_status.id] : [],
    )
    const results = await Promise.allSettled(
      jobIds.map((jobId) => mutations.retryJob.mutateAsync(jobId)),
    )
    const succeeded = results.filter((result) => result.status === "fulfilled").length
    const failed = results.length - succeeded
    if (failed > 0) toast.error(t("ai_processing.banner.retry_partial", { failed, succeeded }))
    else toast.success(t("ai_processing.banner.retry_success", { count: succeeded }))
  }

  return (
    <div
      className="shadow-context-menu absolute left-3 right-3 top-14 z-20 flex items-center gap-3 rounded-xl border border-red/30 bg-material-thick p-3 backdrop-blur-xl"
      role="status"
    >
      <i className="i-mgc-warning-cute-re size-5 shrink-0 text-red" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text">
          {t("ai_processing.banner.title", { count: failures.length })}
        </div>
        <div className="truncate text-xs text-text-secondary">
          {failures[0]?.processing_status?.last_error_summary ??
            t("ai_processing.banner.description")}
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setFilters((current) => ({ ...current, processing: "failed" }))}
      >
        {t("ai_processing.banner.view")}
      </Button>
      <Button size="sm" disabled={mutations.retryJob.isPending} onClick={retryAll}>
        {t("ai_processing.banner.retry")}
      </Button>
      <button
        type="button"
        className="flex size-9 items-center justify-center rounded-lg text-text-secondary transition-colors duration-200 hover:bg-fill-quaternary hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={t("words.close", { ns: "common" })}
        onClick={() => setDismissedCount(failures.length)}
      >
        <i className="i-mgc-close-cute-re size-4" />
      </button>
    </div>
  )
}
