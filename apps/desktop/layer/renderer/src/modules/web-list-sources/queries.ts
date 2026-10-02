import type { WebListSourceInput, WebListSourcePatch } from "@follow/feed-source-contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { webListSourcesClient as client } from "./api"

export const webListSourcesKeys = {
  all: ["web-list-sources"] as const,
  list: ["web-list-sources", "list"] as const,
  items: (id: string) => ["web-list-sources", "items", id] as const,
}
export const useWebListSources = () =>
  useQuery({ queryKey: webListSourcesKeys.list, queryFn: client.list })
export const useWebListItems = (id: string, enabled: boolean) =>
  useQuery({ queryKey: webListSourcesKeys.items(id), queryFn: () => client.items(id, 20), enabled })
export const useWebListSourceActions = () => {
  const queryClient = useQueryClient()
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: webListSourcesKeys.all })
  return {
    create: useMutation({
      mutationFn: (input: WebListSourceInput) => client.create(input),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: WebListSourcePatch }) =>
        client.update(id, patch),
      onSuccess,
    }),
    delete: useMutation({ mutationFn: client.delete, onSuccess }),
    test: useMutation({ mutationFn: (id: string) => client.test(id, true), onSuccess }),
    check: useMutation({ mutationFn: client.check, onSuccess }),
  }
}
