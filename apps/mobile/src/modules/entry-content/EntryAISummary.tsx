import { useEntry } from "@follow/store/entry/hooks"
import { SummaryGeneratingStatus } from "@follow/store/summary/enum"
import {
  useGenerateSummary,
  usePrefetchSummary,
  useSummary,
  useSummaryStatus,
} from "@follow/store/summary/hooks"
import { useAtomValue } from "jotai"
import type { FC } from "react"
import { useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Pressable } from "react-native"
import { useColor } from "react-native-uikit-colors"

import { useActionLanguage, useGeneralSettingKey } from "@/src/atoms/settings/general"
import { ErrorBoundary } from "@/src/components/common/ErrorBoundary"
import { Text } from "@/src/components/ui/typography/Text"
import { AiCuteReIcon } from "@/src/icons/ai_cute_re"
import { renderMarkdown } from "@/src/lib/markdown"

import { AISummary } from "../ai/summary"
import { useEntryContentContext } from "./ctx"

const ATTRIBUTION_PREFIX_PATTERNS = [
  /^(?:(?:据|根据)\s*)?[^，。,:：\n]{1,40}(?:消息|报道|报告|监测|研究|统计|数据|分析)?(?:称|显示|指出|提到|认为|披露|公布)[，,:：]\s*/u,
  /^[^\n,.:;]{1,80}\s+(?:reported|reports|said|says|stated|states|noted|notes)\s*[,.:;]\s*/i,
  /^according to [^\n,.:;]{1,80}[,.:;]\s*/i,
] as const

const stripLeadingAttribution = (text: string) => {
  let result = text
  for (const pattern of ATTRIBUTION_PREFIX_PATTERNS) {
    result = result.replace(pattern, "")
  }
  return result
}

const normalizeSummaryText = (source?: string | null) => {
  if (!source) return ""

  const normalizedWhitespace = source
    .replaceAll(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replaceAll(/[ \t]+/g, " ")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim()

  if (!normalizedWhitespace) return ""

  const withoutAttribution = stripLeadingAttribution(normalizedWhitespace)

  return withoutAttribution
    .replace(/^[，。,:：\s]+/u, "")
    .replaceAll(/\s+([，。！？；：])/g, "$1")
    .trim()
}

const looksLikeMarkdown = (source: string) => {
  return /(?:^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|(?:^|\n)\s*[-*_]{3,}\s*(?:$|\n)|(?:^|\n)\|.+\|/m.test(
    source,
  )
}

export const EntryAISummary: FC<{
  entryId: string
}> = ({ entryId }) => {
  const { t } = useTranslation()
  const ctx = useEntryContentContext()
  const showReadability = useAtomValue(ctx.showReadabilityAtom)
  const showAISummaryOnce = useAtomValue(ctx.showAISummaryAtom)
  const showAISummary = useGeneralSettingKey("summary") || showAISummaryOnce
  const entry = useEntry(
    entryId,
    useCallback(
      (state) => {
        const target =
          showReadability && state.readabilityContent ? "readabilityContent" : "content"
        return {
          target,
        } as const
      },
      [showReadability],
    ),
  )
  const actionLanguage = useActionLanguage()
  const target = entry?.target || "content"
  const summary = useSummary(entryId, actionLanguage)
  // The auto-summary setting only shows summaries that already exist, so browsing spends no AI
  // calls; the one-off command or the generate button asks for a new one.
  const {
    error: summaryError,
    isSuccess: lookupFinished,
    refetch: refetchSummary,
  } = usePrefetchSummary({
    entryId,
    target,
    actionLanguage,
    cachedOnly: !showAISummaryOnce,
    enabled: showAISummary,
  })
  const generate = useGenerateSummary({ entryId, target, actionLanguage })
  const purpleColor = useColor("purple")
  const maybeMarkdown = showReadability
    ? summary?.readabilitySummary || summary?.summary
    : summary?.summary
  const normalizedSummary = useMemo(() => normalizeSummaryText(maybeMarkdown), [maybeMarkdown])
  const summaryToShow = useMemo(() => {
    if (!normalizedSummary) return null
    if (!looksLikeMarkdown(normalizedSummary)) return normalizedSummary
    return renderMarkdown(normalizedSummary)
  }, [normalizedSummary])
  const status = useSummaryStatus({
    entryId,
    actionLanguage,
    target,
  })
  const handleRetry = useCallback(() => {
    if (generate.isError) generate.mutate()
    else refetchSummary()
  }, [generate, refetchSummary])
  if (!showAISummary) return null
  const pending = status === SummaryGeneratingStatus.Pending
  const error = summaryError ?? generate.error
  if (!showAISummaryOnce && lookupFinished && !summaryToShow && !pending && !error) {
    return (
      <Pressable
        onPress={() => generate.mutate()}
        className="my-3 flex-row items-center justify-center gap-2 rounded-xl bg-secondary-system-background p-3 active:opacity-70"
      >
        <AiCuteReIcon height={16} width={16} color={purpleColor} />
        <Text className="text-[15px] font-medium text-label">{t("ai.summary_generate")}</Text>
      </Pressable>
    )
  }
  return (
    <ErrorBoundary
      fallbackRender={() => (
        <Text className="text-[16px] leading-[24px] text-label">
          {t("ai.summary_render_error")}
        </Text>
      )}
    >
      <AISummary
        className="my-3"
        rawSummaryForCopy={normalizedSummary || undefined}
        summary={summaryToShow}
        pending={pending}
        error={error}
        onRetry={status === SummaryGeneratingStatus.Error ? handleRetry : undefined}
      />
    </ErrorBoundary>
  )
}
