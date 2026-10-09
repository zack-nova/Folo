import type {
  EntryEvaluationRecord,
  EntryRecord,
  ProcessingTaxonomySnapshotRecord,
} from "../data/types"

const DEFAULT_FEATURED_HALF_LIFE_DAYS = 7
export const FEATURED_SCORE_THRESHOLD = 70

const positiveNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null

const featuredHalfLifeDays = (
  taxonomy: ProcessingTaxonomySnapshotRecord | null,
  primaryCategory: string,
) => {
  if (!taxonomy) return DEFAULT_FEATURED_HALF_LIFE_DAYS
  const defaultHalfLife =
    positiveNumber(taxonomy.content.default_half_life_days) ?? DEFAULT_FEATURED_HALF_LIFE_DAYS
  const categories = Array.isArray(taxonomy.content.categories) ? taxonomy.content.categories : []
  const category = categories.find(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item) && item.name === primaryCategory,
  )
  return (
    positiveNumber(category?.featured_half_life_days) ??
    positiveNumber(category?.half_life_days) ??
    defaultHalfLife
  )
}

/**
 * Featured ranking score: the overall score decayed by entry age with the taxonomy half-life
 * (see the featured section of folo-integration-plan.md).
 */
export const featuredRankingScore = (
  entry: EntryRecord,
  evaluation: EntryEvaluationRecord,
  taxonomy: ProcessingTaxonomySnapshotRecord | null,
  now = new Date(),
) => {
  const latestReliablePublishedAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000)
  const ageBaseline =
    entry.publishedAt <= latestReliablePublishedAt ? entry.publishedAt : entry.insertedAt
  const ageDays = Math.max(0, now.getTime() - ageBaseline.getTime()) / (24 * 60 * 60 * 1_000)
  const halfLifeDays = featuredHalfLifeDays(taxonomy, evaluation.primaryCategory)
  return evaluation.overallScore * 2 ** (-ageDays / halfLifeDays)
}
