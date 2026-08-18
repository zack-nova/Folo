import { ActionButton, Button } from "@follow/components/ui/button/index.js"
import { Input } from "@follow/components/ui/input/index.js"
import { Label } from "@follow/components/ui/label/index.jsx"
import { Popover, PopoverContent, PopoverTrigger } from "@follow/components/ui/popover/index.js"
import { useFolderFeedsByFeedId } from "@follow/store/subscription/hooks"
import { useAtom } from "jotai"
import { useTranslation } from "react-i18next"

import { useDialog, useModalStack } from "~/components/ui/modal/stacked/hooks"
import { useRouteParams } from "~/hooks/biz/useRouteParams"

import { resolveReEvaluationScope } from "../scope"
import { aiEntryFiltersAtom, defaultAIEntryFilters, hasActiveAIEntryFilters } from "../state"
import { ReEvaluationModalContent } from "./ReEvaluationModalContent"

export const TimelineAIControls = ({ entryIds }: { entryIds: string[] }) => {
  const { t } = useTranslation()
  const [filters, setFilters] = useAtom(aiEntryFiltersAtom)
  const route = useRouteParams()
  const { present } = useModalStack()
  const { ask } = useDialog()
  const isActive = hasActiveAIEntryFilters(filters)
  const folderFeedIds = useFolderFeedsByFeedId({ feedId: route.feedId, view: route.view })

  const openReEvaluation = () => {
    const scope = resolveReEvaluationScope({
      entryIds,
      feedId: route.feedId,
      folderFeedIds,
      isAllFeeds: route.isAllFeeds,
      view: route.view,
    })
    present({
      title: t("ai_processing.reevaluate.title"),
      content: ({ dismiss }) => <ReEvaluationModalContent scope={scope} dismiss={dismiss} />,
    })
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <ActionButton active={isActive} tooltip={t("ai_processing.filters.title")}>
            <i className="i-mgc-filter-cute-re" />
          </ActionButton>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 space-y-4">
          <div>
            <div className="text-sm font-semibold text-text">
              {t("ai_processing.filters.title")}
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              {t("ai_processing.filters.description")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-minimum-score">{t("ai_processing.filters.minimum_score")}</Label>
            <Input
              id="ai-minimum-score"
              min={0}
              max={100}
              type="number"
              value={filters.minimumScore ?? ""}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  minimumScore: event.target.value === "" ? null : Number(event.target.value),
                }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-category">{t("ai_processing.filters.category")}</Label>
            <Input
              id="ai-category"
              value={filters.category ?? ""}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  category: event.target.value.trim() || null,
                }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-tag">{t("ai_processing.filters.tag")}</Label>
            <Input
              id="ai-tag"
              value={filters.tag ?? ""}
              onChange={(event) =>
                setFilters((current) => ({ ...current, tag: event.target.value.trim() || null }))
              }
            />
          </div>
          <label className="flex min-h-11 cursor-pointer items-center justify-between rounded-lg border border-fill-secondary px-3">
            <span className="text-sm">{t("ai_processing.filters.failed_only")}</span>
            <input
              type="checkbox"
              checked={filters.processing === "failed"}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  processing: event.target.checked ? "failed" : "all",
                }))
              }
            />
          </label>
          <Button
            buttonClassName="w-full"
            variant="outline"
            disabled={!isActive}
            onClick={() => setFilters(defaultAIEntryFilters)}
          >
            {t("ai_processing.filters.clear")}
          </Button>
        </PopoverContent>
      </Popover>

      <ActionButton
        tooltip={t("ai_processing.reevaluate.title")}
        onClick={async () => {
          if (
            await ask({
              title: t("ai_processing.reevaluate.title"),
              message: t("ai_processing.reevaluate.scope_confirmation"),
              confirmText: t("ai_processing.reevaluate.continue"),
              cancelText: t("words.cancel", { ns: "common" }),
            })
          ) {
            openReEvaluation()
          }
        }}
      >
        <i className="i-mgc-refresh-3-cute-re" />
      </ActionButton>
    </>
  )
}
