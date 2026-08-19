import type {
  SourceCatalogRenderResult,
  SourceCatalogRoute,
  SourceCatalogTestResult,
} from "@follow/feed-source-contracts"

import { fetchAPI } from "~/lib/api-client"

type ExtensionFetch = (path: string, init?: RequestInit) => Promise<Response>
type APIEnvelope<T> = { code: 0; data: T }
export type SourceCatalogParameters = Record<string, boolean | number | string>

export class SourceCatalogAPIError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "SourceCatalogAPIError"
  }
}

const responsePayload = async <T>(response: Response): Promise<T> => {
  const payload = (await response.json()) as
    APIEnvelope<T> | { code?: string | number; message?: string }
  if (!response.ok || payload.code !== 0 || !("data" in payload)) {
    throw new SourceCatalogAPIError(
      "message" in payload && typeof payload.message === "string"
        ? payload.message
        : "Source catalog request failed",
      String(payload.code ?? "source_catalog_request_failed"),
      response.status,
    )
  }
  return payload.data
}

export const createSourceCatalogClient = (request: ExtensionFetch) => {
  return {
    async list() {
      return responsePayload<{ routes: SourceCatalogRoute[] }>(
        await request("/api/extensions/sources/catalog"),
      )
    },
    async render(routeId: string, parameters: SourceCatalogParameters) {
      return responsePayload<SourceCatalogRenderResult>(
        await request(`/api/extensions/sources/catalog/${encodeURIComponent(routeId)}/render`, {
          body: JSON.stringify({ parameters }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      )
    },
    async test(routeId: string, parameters: SourceCatalogParameters) {
      return responsePayload<SourceCatalogTestResult>(
        await request(`/api/extensions/sources/catalog/${encodeURIComponent(routeId)}/test`, {
          body: JSON.stringify({ parameters }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      )
    },
  }
}

export const sourceCatalogClient = createSourceCatalogClient(fetchAPI)
