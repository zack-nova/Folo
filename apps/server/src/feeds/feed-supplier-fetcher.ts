import type { AutonomousSourceProviderHealth } from "@follow/feed-source-contracts"
import { parseRssHubSource } from "@follow/feed-source-contracts"

import type { FeedFetcher, FetchedFeed } from "./importer"

export interface FeedSupplierFetcherOptions {
  baseURL: string
  fetchImplementation?: typeof fetch
  maxBytes?: number
  timeoutMs?: number
  token: string
}

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

export class FeedSupplierFetcher implements FeedFetcher {
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
      return new URL(input).protocol === "rsshub:"
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
      const payload = (await response.json()) as { providers?: unknown }
      if (!Array.isArray(payload.providers)) throw new Error("Supplier status is invalid")
      const provider = payload.providers.find(
        (item): item is AutonomousSourceProviderHealth =>
          Boolean(item) &&
          typeof item === "object" &&
          "id" in item &&
          item.id === "rsshub" &&
          "status" in item &&
          (item.status === "ready" || item.status === "unavailable"),
      )
      if (!provider) throw new Error("Supplier did not report RSSHub status")
      return [provider]
    } catch (error) {
      return [
        {
          configured: true,
          id: "rsshub",
          message: error instanceof Error ? error.message.slice(0, 500) : "Supplier unavailable",
          status: "unavailable",
        },
      ]
    }
  }

  async fetch(
    input: string,
    options: { etag?: string | null; lastModified?: string | null } = {},
  ): Promise<FetchedFeed> {
    const source = parseRssHubSource(input)
    const requestURL = new URL("v1/feeds/rsshub", this.baseURL)
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
}
