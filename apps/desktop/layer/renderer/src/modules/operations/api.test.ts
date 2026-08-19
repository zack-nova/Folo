import { describe, expect, it, vi } from "vitest"

import { createOperationsClient, OperationsAPIError } from "./api"

describe("operations client", () => {
  it("loads owner status and encodes retry identifiers", async () => {
    const request = vi.fn(async (path: string) =>
      Response.json({
        code: 0,
        data: path.includes("/status")
          ? {
              alerts: [],
              failed_processing_jobs: [],
              feed_failures: [],
              last_cleanup: null,
              last_feed_polling_cycle: null,
              stats: {
                feedAcquisitionFailures: 0,
                feedsDue: 0,
                processingJobs: {
                  failed: 0,
                  queued: 0,
                  running: 0,
                  succeeded: 0,
                  superseded: 0,
                },
                subscribedFeeds: 1,
              },
              status: "healthy",
            }
          : null,
      }),
    )
    const client = createOperationsClient(request)

    await expect(client.getStatus()).resolves.toMatchObject({ status: "healthy" })
    await client.retryFeed("feed/with spaces")
    expect(request).toHaveBeenLastCalledWith(
      "/api/extensions/operations/feeds/feed%2Fwith%20spaces/retry",
      { method: "POST" },
    )
  })

  it("preserves server recovery errors", async () => {
    const client = createOperationsClient(async () =>
      Response.json({ code: "forbidden", message: "Instance owner required" }, { status: 403 }),
    )

    await expect(client.getStatus()).rejects.toEqual(
      new OperationsAPIError("Instance owner required", "forbidden", 403),
    )
  })
})
