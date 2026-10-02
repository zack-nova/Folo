import type {
  WebListCheckResult,
  WebListItem,
  WebListSource,
  WebListSourceInput,
  WebListSourcePatch,
  WebListTestResult,
} from "@follow/feed-source-contracts"

import { fetchAPI } from "~/lib/api-client"

type ExtensionFetch = (path: string, init?: RequestInit) => Promise<Response>
export class WebListSourcesAPIError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "WebListSourcesAPIError"
  }
}

const json = (body: WebListSourceInput | WebListSourcePatch): RequestInit => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
})

const payloadData = async <T>(response: Response): Promise<T> => {
  const payload = (await response.json()) as
    { code: 0; data: T } | { code?: string; message?: string }
  if (!response.ok || payload.code !== 0 || !("data" in payload)) {
    throw new WebListSourcesAPIError(
      "message" in payload && payload.message ? payload.message : "Web list request failed",
      String(payload.code ?? "web_list_request_failed"),
      response.status,
    )
  }
  return payload.data
}

// Every call passes a literal path and method so the compatibility contract scanner can freeze
// the API usage; keep it that way when adding endpoints.
export const createWebListSourcesClient = (request: ExtensionFetch) => {
  const id = (sourceId: string) => encodeURIComponent(sourceId)
  return {
    list: async () =>
      payloadData<{ sources: WebListSource[] }>(
        await request("/api/extensions/sources/web-lists", { method: "GET" }),
      ),
    get: async (sourceId: string) =>
      payloadData<{ source: WebListSource }>(
        await request(`/api/extensions/sources/web-lists/${id(sourceId)}`, { method: "GET" }),
      ),
    create: async (input: WebListSourceInput) =>
      payloadData<{ source: WebListSource }>(
        await request("/api/extensions/sources/web-lists", { method: "POST", ...json(input) }),
      ),
    update: async (sourceId: string, patch: WebListSourcePatch) =>
      payloadData<{ source: WebListSource }>(
        await request(`/api/extensions/sources/web-lists/${id(sourceId)}`, {
          method: "PATCH",
          ...json(patch),
        }),
      ),
    delete: async (sourceId: string) =>
      payloadData<{ deleted: true }>(
        await request(`/api/extensions/sources/web-lists/${id(sourceId)}`, { method: "DELETE" }),
      ),
    test: async (sourceId: string, detail = true) =>
      payloadData<WebListTestResult>(
        await request(`/api/extensions/sources/web-lists/${id(sourceId)}/test?detail=${detail}`, {
          method: "POST",
        }),
      ),
    check: async (sourceId: string) =>
      payloadData<WebListCheckResult>(
        await request(`/api/extensions/sources/web-lists/${id(sourceId)}/check`, {
          method: "POST",
        }),
      ),
    items: async (sourceId: string, limit = 20) =>
      payloadData<{ items: WebListItem[] }>(
        await request(
          `/api/extensions/sources/web-lists/${id(sourceId)}/items?limit=${Math.max(1, Math.min(100, Math.trunc(limit)))}`,
          { method: "GET" },
        ),
      ),
  }
}
export const webListSourcesClient = createWebListSourcesClient(fetchAPI)
