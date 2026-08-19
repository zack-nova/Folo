import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { aiProcessingKeys } from "~/modules/ai-processing"

import { operationsClient } from "./api"

export const operationsKeys = {
  all: ["operations"] as const,
  diagnostics: (feedId: string) => ["operations", "diagnostics", feedId] as const,
  status: ["operations", "status"] as const,
}

export const useOperationsStatus = () =>
  useQuery({
    queryKey: operationsKeys.status,
    queryFn: () => operationsClient.getStatus(),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })

export const useFeedDiagnostics = (feedId: string | null) =>
  useQuery({
    enabled: feedId !== null,
    queryKey: operationsKeys.diagnostics(feedId ?? ""),
    queryFn: () => operationsClient.getFeedDiagnostics(feedId ?? ""),
    staleTime: 15_000,
  })

export const useOperationsMutations = () => {
  const queryClient = useQueryClient()
  const invalidateOperations = () => queryClient.invalidateQueries({ queryKey: operationsKeys.all })

  return {
    retryFeed: useMutation({
      mutationFn: (feedId: string) => operationsClient.retryFeed(feedId),
      onSuccess: invalidateOperations,
    }),
    retryProcessingJob: useMutation({
      mutationFn: (jobId: string) => operationsClient.retryProcessingJob(jobId),
      onSuccess: async () => {
        await Promise.all([
          invalidateOperations(),
          queryClient.invalidateQueries({ queryKey: aiProcessingKeys.all }),
        ])
      },
    }),
  }
}
