import type { SupportedActionLanguage } from "@follow/shared"
import { useMutation, useQuery } from "@tanstack/react-query"

import type { GeneralQueryOptions } from "../../types"
import { summarySyncService, useSummaryStore } from "./store"
import { getGenerateSummaryStatusId } from "./utils"

export const useSummary = (entryId: string, language: SupportedActionLanguage) => {
  const summary = useSummaryStore((state) => state.data[entryId]?.[language])
  return summary
}

export const useSummaryStatus = ({
  entryId,
  actionLanguage,
  target,
}: {
  entryId: string
  actionLanguage: SupportedActionLanguage
  target: "content" | "readabilityContent"
}) => {
  const status = useSummaryStore(
    (state) => state.generatingStatus[getGenerateSummaryStatusId(entryId, actionLanguage, target)],
  )
  return status
}

export function usePrefetchSummary({
  entryId,
  target,
  actionLanguage,
  cachedOnly = false,
  ...options
}: {
  entryId: string
  target: "content" | "readabilityContent"
  actionLanguage: SupportedActionLanguage
  /** Only read summaries that already exist; see summarySyncService.generateSummary. */
  cachedOnly?: boolean
} & GeneralQueryOptions) {
  return useQuery({
    queryKey: ["summary", entryId, target, actionLanguage, cachedOnly],
    queryFn: () => {
      return summarySyncService.generateSummary({ entryId, target, actionLanguage, cachedOnly })
    },
    enabled: options?.enabled,
    staleTime: 1000 * 60 * 60 * 24,
  })
}

/** Generates a summary the owner asked for explicitly. */
export function useGenerateSummary({
  entryId,
  target,
  actionLanguage,
}: {
  entryId: string
  target: "content" | "readabilityContent"
  actionLanguage: SupportedActionLanguage
}) {
  return useMutation({
    mutationKey: ["summary", "generate", entryId, target, actionLanguage],
    mutationFn: () => summarySyncService.generateSummary({ entryId, target, actionLanguage }),
  })
}
