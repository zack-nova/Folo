import { describe, expect, it, vi } from "vitest"

import { createAIProcessingClient } from "./api"

describe("AI processing extension client", () => {
  it("loads entry projections in batches of one hundred without per-entry requests", async () => {
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      const entryIds = (JSON.parse(init?.body as string) as { entry_ids: string[] }).entry_ids
      return new Response(
        JSON.stringify({
          code: 0,
          data: Object.fromEntries(
            entryIds.map((entryId) => [entryId, { evaluation: null, processing_status: null }]),
          ),
        }),
        { headers: { "content-type": "application/json" } },
      )
    })
    const client = createAIProcessingClient(request)
    const entryIds = Array.from({ length: 205 }, (_, index) => `entry-${index}`)

    const projections = await client.getEntryProjections(entryIds)

    expect(request).toHaveBeenCalledTimes(3)
    expect(Object.keys(projections)).toHaveLength(205)
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "/api/extensions/entries/projections",
      "/api/extensions/entries/projections",
      "/api/extensions/entries/projections",
    ])
  })

  it("surfaces the server recovery message for failed extension requests", async () => {
    const client = createAIProcessingClient(
      async () =>
        new Response(
          JSON.stringify({
            code: "processing_configuration_required",
            message: "Create a profile and taxonomy before evaluation",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    )

    await expect(client.createProcessingJob("entry-1")).rejects.toThrow(
      "Create a profile and taxonomy before evaluation",
    )
  })
})
