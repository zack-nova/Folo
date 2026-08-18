import type { EntryProjection, ProcessingJobStatus } from "./types"

export type EntryAIStatusModel = {
  category: string | null
  errorSummary: string | null
  isConfigurationOutdated: boolean
  jobId: string | null
  score: number | null
  status: ProcessingJobStatus | null
  tags: string[]
}

export const getEntryAIStatusModel = (
  projection: EntryProjection | null | undefined,
): EntryAIStatusModel => {
  const evaluation = projection?.evaluation
  return {
    category: evaluation
      ? [evaluation.primary_category, evaluation.secondary_category].filter(Boolean).join(" / ")
      : null,
    errorSummary: projection?.processing_status?.last_error_summary ?? null,
    isConfigurationOutdated: evaluation?.configuration_outdated ?? false,
    jobId: projection?.processing_status?.id ?? null,
    score: evaluation?.overall_score ?? null,
    status: projection?.processing_status?.status ?? null,
    tags: evaluation?.tags ?? [],
  }
}
