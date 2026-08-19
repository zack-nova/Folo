import type {
  AutonomousSourceProviderHealth,
  SourceCatalogRenderResult,
  SourceCatalogRoute,
  SourceCatalogTestResult,
} from "@follow/feed-source-contracts"
import { parsePageChangeSource, parseRssHubSource } from "@follow/feed-source-contracts"
import { z } from "zod"

import type { FeedFetcher, FetchedFeed } from "./importer"

export interface FeedSupplierFetcherOptions {
  baseURL: string
  fetchImplementation?: typeof fetch
  maxBytes?: number
  timeoutMs?: number
  token: string
}

export interface SourceCatalogClient {
  listRoutes(): Promise<SourceCatalogRoute[]>
  renderRoute(
    routeId: string,
    parameters: Record<string, boolean | number | string>,
  ): Promise<SourceCatalogRenderResult>
  testRoute(
    routeId: string,
    parameters: Record<string, boolean | number | string>,
  ): Promise<SourceCatalogTestResult>
}

const sourceCatalogValue = z.union([z.boolean(), z.number().int().safe(), z.string().max(512)])
const sourceCatalogParameter = z
  .object({
    defaultValue: sourceCatalogValue.nullable(),
    description: z.string().max(500).nullable(),
    key: z.string().min(1).max(64),
    label: z.string().min(1).max(128),
    location: z.enum(["path", "query"]),
    maximum: z.number().int().safe().nullable(),
    minimum: z.number().int().safe().nullable(),
    options: z
      .array(z.object({ label: z.string().max(128), value: z.string().max(256) }).strict())
      .max(100),
    required: z.boolean(),
    type: z.enum(["boolean", "enum", "integer", "string"]),
  })
  .strict()
const sourceCatalogRoute = z
  .object({
    category: z.string().min(1).max(128),
    createdAt: z.string().min(1).max(64),
    description: z.string().max(1_000).nullable(),
    documentationURL: z.string().max(2_048).nullable(),
    enabled: z.boolean(),
    id: z.string().min(1).max(128),
    key: z.string().min(1).max(128),
    parameters: z.array(sourceCatalogParameter).max(32),
    requiresCredentials: z.boolean(),
    routePathTemplate: z.string().min(2).max(1_024),
    title: z.string().min(1).max(128),
    updatedAt: z.string().min(1).max(64),
  })
  .strict()
const sourceCatalogList = z.object({ routes: z.array(sourceCatalogRoute) }).strict()
const sourceCatalogRender = z.object({ logicalURL: z.string().min(1).max(2_048) }).strict()
const sourceCatalogTest = sourceCatalogRender
  .extend({
    contentBytes: z.number().int().min(0),
    contentType: z.string().max(256).nullable(),
    upstreamStatus: z.number().int().min(100).max(599),
    upstreamURL: z.string().min(1).max(2_048),
  })
  .strict()
const sourceProviderHealth = z
  .object({
    activeRequestCount: z.number().int().min(0).optional(),
    cacheHitCount: z.number().int().min(0).optional(),
    cacheMissCount: z.number().int().min(0).optional(),
    cacheStatus: z.enum(["ready", "unavailable"]).optional(),
    catalogRouteCount: z.number().int().min(0).optional(),
    coalescedRequestCount: z.number().int().min(0).optional(),
    configured: z.boolean(),
    concurrencyRejectedRequestCount: z.number().int().min(0).optional(),
    dueSourceCount: z.number().int().min(0).optional(),
    enabledSourceCount: z.number().int().min(0).optional(),
    id: z.enum(["page_change", "rsshub"]),
    lastCycleAt: z.string().max(64).nullable().optional(),
    managedRouteCount: z.number().int().min(0).optional(),
    message: z.string().max(500).nullable(),
    persistenceStatus: z.enum(["ready", "unavailable"]).optional(),
    registryMode: z.enum(["managed_only", "permissive"]).optional(),
    rateLimitedRequestCount: z.number().int().min(0).optional(),
    status: z.enum(["ready", "unavailable"]),
  })
  .strict()
const sourceProviderList = z.object({ providers: z.array(sourceProviderHealth) }).strict()

const boundedBody = async (response: Response, maximumBytes: number): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Feed supplier response exceeds the ${maximumBytes} byte limit`)
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maximumBytes) {
      await reader.cancel()
      throw new Error(`Feed supplier response exceeds the ${maximumBytes} byte limit`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
}

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { message?: unknown }
    if (typeof payload.message === "string") return payload.message.slice(0, 500)
  } catch {
    // Supplier error bodies are optional.
  }
  return `Feed supplier request failed with HTTP ${response.status}`
}

export class FeedSupplierFetcher implements FeedFetcher, SourceCatalogClient {
  readonly providerId = "feed_supplier" as const
  private readonly baseURL: URL
  private readonly fetchImplementation: typeof fetch
  private readonly maxBytes: number
  private readonly timeoutMs: number
  private readonly token: string

  constructor(options: FeedSupplierFetcherOptions) {
    this.baseURL = new URL(`${options.baseURL.replace(/\/$/, "")}/`)
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.token = options.token
  }

  providerFor(): "feed_supplier" {
    return "feed_supplier"
  }

  supports(input: string): boolean {
    try {
      const protocol = new URL(input).protocol
      return protocol === "pagechange:" || protocol === "rsshub:"
    } catch {
      return false
    }
  }

  async getProviderStatuses(): Promise<AutonomousSourceProviderHealth[]> {
    try {
      const response = await this.fetchImplementation(new URL("v1/providers", this.baseURL), {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5_000)),
      })
      if (!response.ok) throw new Error(`Supplier returned HTTP ${response.status}`)
      const parsed = sourceProviderList.safeParse(await response.json())
      if (!parsed.success) throw new Error("Supplier status is invalid")
      const providers: AutonomousSourceProviderHealth[] = parsed.data.providers
      if (!providers.some((provider) => provider.id === "rsshub")) {
        throw new Error("Supplier did not report RSSHub status")
      }
      if (!providers.some((provider) => provider.id === "page_change")) {
        throw new Error("Supplier did not report page change status")
      }
      return providers
    } catch (error) {
      return [
        {
          configured: true,
          id: "rsshub",
          message: error instanceof Error ? error.message.slice(0, 500) : "Supplier unavailable",
          status: "unavailable",
        },
        {
          configured: true,
          id: "page_change",
          message: error instanceof Error ? error.message.slice(0, 500) : "Supplier unavailable",
          status: "unavailable",
        },
      ]
    }
  }

  async listRoutes(): Promise<SourceCatalogRoute[]> {
    const payload = await this.requestJSON<unknown>("v1/catalog/routes")
    const parsed = sourceCatalogList.safeParse(payload)
    if (!parsed.success) throw new Error("Supplier catalog response is invalid")
    return parsed.data.routes
  }

  async renderRoute(
    routeId: string,
    parameters: Record<string, boolean | number | string>,
  ): Promise<SourceCatalogRenderResult> {
    const payload = await this.requestJSON<unknown>(
      `v1/catalog/routes/${encodeURIComponent(routeId)}/render`,
      parameters,
    )
    const parsed = sourceCatalogRender.safeParse(payload)
    if (!parsed.success) throw new TypeError("Supplier catalog render response is invalid")
    return parsed.data
  }

  async testRoute(
    routeId: string,
    parameters: Record<string, boolean | number | string>,
  ): Promise<SourceCatalogTestResult> {
    const payload = await this.requestJSON<unknown>(
      `v1/catalog/routes/${encodeURIComponent(routeId)}/test`,
      parameters,
    )
    const parsed = sourceCatalogTest.safeParse(payload)
    if (!parsed.success) throw new Error("Supplier catalog test response is invalid")
    return parsed.data
  }

  async fetch(
    input: string,
    options: { etag?: string | null; lastModified?: string | null } = {},
  ): Promise<FetchedFeed> {
    const protocol = new URL(input).protocol
    const source =
      protocol === "pagechange:" ? parsePageChangeSource(input) : parseRssHubSource(input)
    const requestURL = new URL(
      protocol === "pagechange:" ? "v1/feeds/page-change" : "v1/feeds/rsshub",
      this.baseURL,
    )
    requestURL.searchParams.set("url", source.logicalURL)
    const headers = new Headers({ authorization: `Bearer ${this.token}` })
    if (options.etag) headers.set("if-none-match", options.etag)
    if (options.lastModified) headers.set("if-modified-since", options.lastModified)

    const response = await this.fetchImplementation(requestURL, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const reportedUpstream = response.headers.get("x-folo-upstream-url")
    const responseURL = reportedUpstream ? new URL(reportedUpstream) : requestURL
    responseURL.searchParams.delete("key")

    if (response.status === 304) {
      return {
        body: "",
        contentType: response.headers.get("content-type"),
        etag: response.headers.get("etag"),
        identityURL: source.logicalURL,
        lastModified: response.headers.get("last-modified"),
        notModified: true,
        status: 304,
        url: responseURL.toString(),
      }
    }
    if (!response.ok) throw new Error(await errorMessage(response))

    return {
      body: await boundedBody(response, this.maxBytes),
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      identityURL: source.logicalURL,
      lastModified: response.headers.get("last-modified"),
      notModified: false,
      status: response.status,
      url: responseURL.toString(),
    }
  }

  private async requestJSON<T>(
    path: string,
    parameters?: Record<string, boolean | number | string>,
  ): Promise<T> {
    const response = await this.fetchImplementation(new URL(path, this.baseURL), {
      body: parameters === undefined ? undefined : JSON.stringify({ parameters }),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        ...(parameters === undefined ? {} : { "content-type": "application/json" }),
      },
      method: parameters === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(await errorMessage(response))
    return (await response.json()) as T
  }
}
