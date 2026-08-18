import { atom, useAtomValue } from "jotai"

import { jotaiStore } from "~/lib/jotai"

import type { EntryProjection } from "./types"

export type AIEntryFilters = {
  minimumScore: number | null
  category: string | null
  tag: string | null
  processing: "all" | "failed"
}

export const defaultAIEntryFilters: AIEntryFilters = {
  category: null,
  minimumScore: null,
  processing: "all",
  tag: null,
}

export const aiEntryFiltersAtom = atom<AIEntryFilters>(defaultAIEntryFilters)
const entryProjectionsAtom = atom<Record<string, EntryProjection>>({})

export const setEntryProjections = (projections: Record<string, EntryProjection>) => {
  jotaiStore.set(entryProjectionsAtom, (current) => ({ ...current, ...projections }))
}

export const useEntryProjection = (entryId: string) => useAtomValue(entryProjectionsAtom)[entryId]

export const useEntryProjectionCollection = (entryIds: string[]) => {
  const projections = useAtomValue(entryProjectionsAtom)
  return Object.fromEntries(
    entryIds.flatMap((entryId) =>
      projections[entryId] ? ([[entryId, projections[entryId]]] as const) : [],
    ),
  ) as Record<string, EntryProjection>
}

export const hasActiveAIEntryFilters = (filters: AIEntryFilters) =>
  filters.minimumScore !== null ||
  filters.category !== null ||
  filters.tag !== null ||
  filters.processing !== "all"

export const applyEntryProjectionFilters = (
  entryIds: string[],
  projections: Record<string, EntryProjection>,
  filters: AIEntryFilters,
) =>
  entryIds.filter((entryId) => {
    const projection = projections[entryId]
    const evaluation = projection?.evaluation
    if (
      filters.minimumScore !== null &&
      (!evaluation || evaluation.overall_score < filters.minimumScore)
    ) {
      return false
    }
    if (
      filters.category !== null &&
      evaluation?.primary_category !== filters.category &&
      evaluation?.secondary_category !== filters.category
    ) {
      return false
    }
    if (filters.tag !== null && !evaluation?.tags.includes(filters.tag)) return false
    if (filters.processing === "failed" && projection?.processing_status?.status !== "failed") {
      return false
    }
    return true
  })

export const hasActiveProcessing = (projections: Record<string, EntryProjection>) =>
  Object.values(projections).some(
    (projection) =>
      projection.processing_status?.status === "queued" ||
      projection.processing_status?.status === "running",
  )
