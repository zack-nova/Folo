import { describe, expect, it } from "vitest"

import { getEntryAIStatusModel } from "./presentation"
import type { EntryProjection } from "./types"

describe("entry AI status presentation", () => {
  it("keeps evaluation facts separate from processing failures", () => {
    const projection = {
      evaluation: {
        configuration_outdated: true,
        overall_score: 83,
        primary_category: "Technology",
        secondary_category: "RSS",
        tags: ["self-hosted"],
      },
      processing_status: {
        id: "job-1",
        last_error_summary: "Provider temporarily unavailable",
        status: "failed",
      },
    } as EntryProjection

    expect(getEntryAIStatusModel(projection)).toEqual({
      category: "Technology / RSS",
      errorSummary: "Provider temporarily unavailable",
      isConfigurationOutdated: true,
      jobId: "job-1",
      score: 83,
      status: "failed",
      tags: ["self-hosted"],
    })
  })
})
