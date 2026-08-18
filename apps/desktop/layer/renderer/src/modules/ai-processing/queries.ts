import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"

import { aiProcessingClient } from "./api"
import { hasActiveProcessing, setEntryProjections } from "./state"
import type { ReEvaluationScope } from "./types"

export const aiProcessingKeys = {
  all: ["ai-processing"] as const,
  configuration: ["ai-processing", "configuration"] as const,
  evaluation: (entryId: string) => ["ai-processing", "evaluation", entryId] as const,
  processingStatus: (entryId: string) => ["ai-processing", "status", entryId] as const,
  projections: (entryIds: string[]) =>
    ["ai-processing", "projections", [...new Set(entryIds)].sort().join(",")] as const,
}

export const useEntryProjections = (entryIds: string[], enabled = true) => {
  const query = useQuery({
    enabled: enabled && entryIds.length > 0,
    queryKey: aiProcessingKeys.projections(entryIds),
    queryFn: () => aiProcessingClient.getEntryProjections(entryIds),
    refetchInterval: ({ state }) => (state.data && hasActiveProcessing(state.data) ? 5_000 : false),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  })

  useEffect(() => {
    if (query.data) setEntryProjections(query.data)
  }, [query.data])

  return query
}

export const useEntryEvaluation = (entryId: string, enabled = true) =>
  useQuery({
    enabled: enabled && !!entryId,
    queryKey: aiProcessingKeys.evaluation(entryId),
    queryFn: () => aiProcessingClient.getEntryEvaluation(entryId),
  })

export const useProcessingConfiguration = (enabled = true) =>
  useQuery({
    enabled,
    queryKey: aiProcessingKeys.configuration,
    queryFn: async () => {
      const [provider, profiles, taxonomies] = await Promise.all([
        aiProcessingClient.getProvider(),
        aiProcessingClient.getProfiles(),
        aiProcessingClient.getTaxonomies(),
      ])
      return { profiles, provider, taxonomies }
    },
  })

export const useAIProcessingMutations = () => {
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: aiProcessingKeys.all })

  return {
    createJob: useMutation({
      mutationFn: ({ entryId, forceRerun }: { entryId: string; forceRerun?: boolean }) =>
        aiProcessingClient.createProcessingJob(entryId, forceRerun),
      onSuccess: invalidate,
    }),
    retryJob: useMutation({
      mutationFn: (jobId: string) => aiProcessingClient.retryProcessingJob(jobId),
      onSuccess: invalidate,
    }),
    selectEvaluation: useMutation({
      mutationFn: ({ entryId, evaluationId }: { entryId: string; evaluationId: string }) =>
        aiProcessingClient.selectEntryEvaluation(entryId, evaluationId),
      onSuccess: invalidate,
    }),
    previewReEvaluation: useMutation({
      mutationFn: (scope: ReEvaluationScope) => aiProcessingClient.previewReEvaluation(scope),
    }),
    createReEvaluationJobs: useMutation({
      mutationFn: (scope: ReEvaluationScope) => aiProcessingClient.createReEvaluationJobs(scope),
      onSuccess: invalidate,
    }),
  }
}
