import { describe, expect, it } from "vitest"

import { applyEntryProjectionFilters, hasActiveProcessing } from "./state"
import type { EntryProjection } from "./types"

const projection = (
  score: number,
  category: string,
  tags: string[],
  status: EntryProjection["processing_status"] extends infer T
    ? T extends { status: infer S }
      ? S
      : never
    : never,
): EntryProjection => ({
  evaluation: {
    configuration_outdated: false,
    content_fingerprint: "fingerprint",
    details: {},
    entry_id: "entry",
    id: "evaluation",
    importance_score: score,
    overall_score: score,
    primary_category: category,
    processed_at: "2026-08-18T00:00:00.000Z",
    processor_name: "ai-evaluation",
    processor_type: "ai",
    processor_version: "1",
    profile_snapshot_id: "profile",
    recommendation_reason: "Reason",
    relevance_score: score,
    score_formula_version: "weighted-v1",
    secondary_category: null,
    tags,
    taxonomy_snapshot_id: "taxonomy",
    timeliness_score: score,
  },
  processing_status: status
    ? {
        attempt_count: 1,
        entry_id: "entry",
        finished_at: null,
        force_rerun: false,
        id: "job",
        last_error_code: status === "failed" ? "provider_error" : null,
        last_error_summary: status === "failed" ? "Provider unavailable" : null,
        next_retry_at: null,
        priority: 0,
        processor_name: "ai-evaluation",
        processor_version: "1",
        profile_snapshot_id: "profile",
        purpose: "entry_evaluation",
        queued_at: "2026-08-18T00:00:00.000Z",
        score_formula_version: "weighted-v1",
        started_at: null,
        status,
        superseded_by_job_id: null,
        taxonomy_snapshot_id: "taxonomy",
      }
    : null,
})

describe("AI timeline projection state", () => {
  it("combines score, category, tag, and failed-processing filters", () => {
    const projections = {
      first: projection(92, "Technology", ["rss", "self-hosted"], "failed"),
      second: projection(80, "Research", ["paper"], "succeeded"),
      third: projection(60, "Technology", ["rss"], "failed"),
    }

    expect(
      applyEntryProjectionFilters(["first", "second", "third"], projections, {
        category: "Technology",
        minimumScore: 70,
        processing: "failed",
        tag: "rss",
      }),
    ).toEqual(["first"])
  })

  it("only polls while a visible entry is queued or running", () => {
    expect(hasActiveProcessing({ first: projection(80, "Technology", [], "queued") })).toBe(true)
    expect(hasActiveProcessing({ first: projection(80, "Technology", [], "failed") })).toBe(false)
  })
})
