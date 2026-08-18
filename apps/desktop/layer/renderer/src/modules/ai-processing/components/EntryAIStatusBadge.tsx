import { cn } from "@follow/utils/utils"
import { useTranslation } from "react-i18next"

import { getEntryAIStatusModel } from "../presentation"
import { useEntryProjection } from "../state"

export const EntryAIStatusBadge = ({ entryId }: { entryId: string }) => {
  const { t } = useTranslation()
  const model = getEntryAIStatusModel(useEntryProjection(entryId))

  if (model.score === null && model.status === null) return null

  const active = model.status === "queued" || model.status === "running"
  const activeStatus = model.status === "queued" ? "queued" : "running"
  const failed = model.status === "failed"

  return (
    <div
      className={cn(
        "pointer-events-none absolute bottom-1 right-2 z-[1] flex max-w-[70%] items-center gap-1 rounded-md border border-fill-secondary bg-material-ultra-thick px-1.5 py-1 text-[10px] font-medium text-text-secondary shadow-sm backdrop-blur-md",
        failed && "border-red/30 text-red",
      )}
      data-testid="entry-ai-status"
    >
      {active && (
        <i className="i-mgc-loading-3-cute-re size-3 animate-spin f-motion-reduce:animate-none" />
      )}
      {failed && <i className="i-mgc-warning-cute-re size-3" />}
      {model.score !== null && (
        <span className="tabular-nums text-text" title={t("ai_processing.overall_score")}>
          {model.score}
        </span>
      )}
      {model.category && <span className="truncate">{model.category}</span>}
      {active && <span>{t(`ai_processing.status.${activeStatus}`)}</span>}
      {failed && <span>{t("ai_processing.status.failed")}</span>}
      {model.isConfigurationOutdated && (
        <i
          className="i-mgc-history-cute-re size-3 text-orange"
          aria-label={t("ai_processing.configuration_outdated")}
        />
      )}
    </div>
  )
}
