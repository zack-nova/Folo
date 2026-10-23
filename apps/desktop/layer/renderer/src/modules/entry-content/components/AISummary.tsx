import { Button } from "@follow/components/ui/button/index.js"
import { useEntry } from "@follow/store/entry/hooks"
import { useGenerateSummary, usePrefetchSummary, useSummary } from "@follow/store/summary/hooks"
import { useTranslation } from "react-i18next"

import { useShowAISummary, useShowAISummaryOnce } from "~/atoms/ai-summary"
import { useEntryIsInReadabilitySuccess } from "~/atoms/readability"
import {
  AIChatPanelStyle,
  setAIPanelVisibility,
  useAIChatPanelStyle,
  useAIPanelVisibility,
} from "~/atoms/settings/ai"
import { useActionLanguage } from "~/atoms/settings/general"
import { AISummaryCardBase } from "~/components/ui/ai-summary-card"

export function AISummary({ entryId }: { entryId: string }) {
  const { t } = useTranslation()
  const summarySetting = useEntry(entryId, (state) => state.settings?.summary)
  const isInReadabilitySuccess = useEntryIsInReadabilitySuccess(entryId)
  const showAISummary = useShowAISummary(summarySetting)
  const showAISummaryOnce = useShowAISummaryOnce()
  // A feed action or the one-off command asks for this entry's summary explicitly. The general
  // auto-summary setting only shows summaries that already exist, so browsing spends no AI calls.
  const generateAutomatically = !!summarySetting || showAISummaryOnce

  const actionLanguage = useActionLanguage()
  const target = isInReadabilitySuccess ? "readabilityContent" : "content"

  // AI Chat panel state
  const aiChatPanelStyle = useAIChatPanelStyle()
  const isAIPanelVisible = useAIPanelVisibility()

  const summary = usePrefetchSummary({
    actionLanguage,
    entryId,
    target,
    cachedOnly: !generateAutomatically,
    enabled: showAISummary,
  })
  const stored = useSummary(entryId, actionLanguage)
  const generate = useGenerateSummary({ actionLanguage, entryId, target })
  const content =
    (target === "readabilityContent" ? stored?.readabilitySummary : stored?.summary) ||
    summary.data ||
    generate.data

  // Show Ask AI button when:
  // 1. Panel style is floating AND panel is not visible
  // 2. OR panel style is fixed (since fixed panel can be toggled)
  const shouldShowAskAI =
    (aiChatPanelStyle === AIChatPanelStyle.Floating && !isAIPanelVisible) ||
    aiChatPanelStyle === AIChatPanelStyle.Fixed

  const handleAskAI = () => {
    setAIPanelVisibility(true)
  }

  if (!showAISummary) {
    return null
  }

  return (
    <AISummaryCardBase
      content={content}
      isLoading={summary.isLoading || generate.isPending}
      className="my-8"
      title={t("entry_content.ai_summary")}
      showAskAIButton={shouldShowAskAI}
      onAskAI={handleAskAI}
      error={summary.error ?? generate.error}
      emptyContent={
        generateAutomatically ? undefined : (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => generate.mutate()}>
              <i className="i-mgc-ai-cute-re mr-1.5" />
              {t("ai.summary_generate")}
            </Button>
          </div>
        )
      }
    />
  )
}
