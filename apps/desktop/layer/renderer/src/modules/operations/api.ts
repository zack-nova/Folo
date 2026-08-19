import { fetchAPI } from "~/lib/api-client"
import type { ProcessingJob } from "~/modules/ai-processing/types"

import type { FeedDiagnostics, OperationsStatus } from "./types"

type ExtensionFetch = (path: string, init?: RequestInit) => Promise<Response>
type APIEnvelope<T> = { code: 0; data: T }

export class OperationsAPIError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "OperationsAPIError"
  }
}

const responsePayload = async <T>(response: Response): Promise<T> => {
  const payload = (await response.json()) as
    APIEnvelope<T> | { code?: string | number; message?: string }
  if (!response.ok || payload.code !== 0 || !("data" in payload)) {
    throw new OperationsAPIError(
      "message" in payload && typeof payload.message === "string"
        ? payload.message
        : "Operations request failed",
      String(payload.code ?? "operations_request_failed"),
      response.status,
    )
  }
  return payload.data
}

export const createOperationsClient = (request: ExtensionFetch) => ({
  async getFeedDiagnostics(feedId: string) {
    return responsePayload<FeedDiagnostics>(
      await request(
        `/api/extensions/subscriptions/${encodeURIComponent(feedId)}/acquisition/diagnostics?limit=20`,
      ),
    )
  },
  async getStatus() {
    return responsePayload<OperationsStatus>(await request("/api/extensions/operations/status"))
  },
  async retryFeed(feedId: string) {
    return responsePayload<null>(
      await request(`/api/extensions/operations/feeds/${encodeURIComponent(feedId)}/retry`, {
        method: "POST",
      }),
    )
  },
  async retryProcessingJob(jobId: string) {
    return responsePayload<ProcessingJob>(
      await request(`/api/extensions/processing/jobs/${encodeURIComponent(jobId)}/retry`, {
        headers: { "content-type": "application/json" },
        method: "POST",
        body: "{}",
      }),
    )
  },
})

export const operationsClient = createOperationsClient(fetchAPI)
