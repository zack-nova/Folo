import { useMutation, useQuery } from "@tanstack/react-query"

import type { SourceCatalogParameters } from "./api"
import { sourceCatalogClient } from "./api"

export const sourceCatalogKeys = {
  all: ["source-catalog"] as const,
  list: ["source-catalog", "list"] as const,
}

export const useSourceCatalog = () =>
  useQuery({
    queryFn: () => sourceCatalogClient.list(),
    queryKey: sourceCatalogKeys.list,
    staleTime: 60_000,
  })

export const useSourceCatalogActions = () => ({
  render: useMutation({
    mutationFn: ({ parameters, routeId }: CatalogActionInput) =>
      sourceCatalogClient.render(routeId, parameters),
  }),
  test: useMutation({
    mutationFn: ({ parameters, routeId }: CatalogActionInput) =>
      sourceCatalogClient.test(routeId, parameters),
  }),
})

interface CatalogActionInput {
  parameters: SourceCatalogParameters
  routeId: string
}
