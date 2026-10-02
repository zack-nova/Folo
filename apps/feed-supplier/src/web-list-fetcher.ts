import { setTimeout as delay } from "node:timers/promises"

import type { WebListItem, WebListSource } from "@follow/feed-source-contracts"

import type { SafeHTTPOptions } from "./safe-http"
import { decodeBody, SafeHTTPClient } from "./safe-http"
import type { ExtractedListItem } from "./web-list-extraction"
import {
  extractDetail,
  extractHTMLList,
  extractJSONList,
  WebListError,
} from "./web-list-extraction"
import type { StoredWebListSource } from "./web-list-repository"

export interface WebListDetail extends Pick<WebListItem, "content" | "detailStatus" | "title"> {
  /** Publication date found on the detail page, used when the list had none. */
  publishedAt: string | null
}
export interface WebListFetchResult {
  items: ExtractedListItem[]
  finalURL: string
  pagesRead: number
  etag: string | null
  lastModified: string | null
  notModified: boolean
  complete: boolean
}
const attachmentPath = /\.(?:7z|docx?|pdf|pptx?|rar|xlsx?|zip)$/i
// A missing content type is treated like HTML, matching the page change fetcher.
const isHTMLContentType = (type: string): boolean =>
  !type || /text\/html|application\/xhtml\+xml/.test(type)

export class WebListFetcher {
  private readonly client: SafeHTTPClient
  readonly timeoutMs: number
  readonly requestDelayMs: number
  constructor(options: SafeHTTPOptions & { requestDelayMs?: number }) {
    this.client = new SafeHTTPClient(options)
    this.timeoutMs = options.timeoutMs
    this.requestDelayMs = options.requestDelayMs ?? 500
  }
  async fetch(source: StoredWebListSource, now = new Date()): Promise<WebListFetchResult> {
    const result: WebListFetchResult = {
      items: [],
      finalURL: source.targetURL,
      pagesRead: 0,
      etag: null,
      lastModified: null,
      notModified: false,
      complete: true,
    }
    let url: string | null = source.targetURL
    const pages = new Set<string>()
    const seenItems = new Set<string>()
    let refreshes = 0
    while (url && result.pagesRead < source.maxPages && result.items.length < source.maxItems) {
      if (pages.has(url)) break
      pages.add(url)
      const headers = new Headers({
        accept:
          source.format === "json"
            ? "application/json, text/plain;q=0.9, */*;q=0.1"
            : "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8",
        "user-agent": "Folo-Feed-Supplier/1.0 (+web list monitor)",
      })
      if (!result.pagesRead) {
        if (source.etag) headers.set("if-none-match", source.etag)
        if (source.lastModified) headers.set("if-modified-since", source.lastModified)
      }
      try {
        const response = await this.client.get(url, headers)
        if (response.finalURL !== url && pages.has(response.finalURL)) break
        pages.add(response.finalURL)
        result.finalURL = response.finalURL
        if (!result.pagesRead) {
          result.etag =
            response.headers.get("etag") ?? (response.status === 304 ? source.etag : null)
          result.lastModified =
            response.headers.get("last-modified") ??
            (response.status === 304 ? source.lastModified : null)
          if (response.status === 304) {
            result.notModified = true
            result.pagesRead = 1
            return result
          }
        }
        const type = response.headers.get("content-type")?.toLowerCase() ?? ""
        if (type && !/text\/|json|xml/.test(type))
          throw new WebListError("web_list_content_type_unsupported", "List must return text", 502)
        const body = decodeBody(response.bytes, type)
        const extracted: ReturnType<typeof extractHTMLList> =
          source.format === "html"
            ? extractHTMLList(body, source, response.finalURL, now)
            : { items: extractJSONList(body, source, now), nextURL: null, refreshURL: null }
        if (extracted.refreshURL) {
          if (refreshes >= 3)
            throw new WebListError(
              "web_list_refresh_limit",
              "List has too many meta refreshes",
              502,
            )
          refreshes++
          url = extracted.refreshURL
          continue
        }
        result.pagesRead++
        for (const item of extracted.items) {
          if (seenItems.has(item.url)) continue
          seenItems.add(item.url)
          result.items.push(item)
          if (result.items.length >= source.maxItems) break
        }
        url = extracted.nextURL
      } catch (error) {
        if (!result.pagesRead) throw error
        result.complete = false
        break
      }
    }
    return result
  }
  async detail(
    item: ExtractedListItem,
    source: WebListSource,
    now = new Date(),
  ): Promise<WebListDetail> {
    const skipped = {
      title: item.title,
      content: null,
      detailStatus: "skipped" as const,
      publishedAt: null,
    }
    // Government lists often link straight to PDF or Office attachments; never download them.
    if (attachmentPath.test(new URL(item.url).pathname)) return skipped
    try {
      const response = await this.client.get(
        item.url,
        new Headers({
          accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.1",
          "user-agent": "Folo-Feed-Supplier/1.0 (+web list monitor)",
        }),
        { acceptsContentType: isHTMLContentType },
      )
      const type = response.headers.get("content-type")?.toLowerCase() ?? ""
      if (!isHTMLContentType(type)) return skipped
      const { content, publishedAt, title } = extractDetail(
        decodeBody(response.bytes, type),
        source,
        response.finalURL,
        item.title,
        undefined,
        { metadata: item.metadata, now },
      )
      return { content, detailStatus: "fetched", publishedAt, title }
    } catch {
      return { title: item.title, content: null, detailStatus: "failed", publishedAt: null }
    }
  }
  async waitForOrigin(url: string, lastRequests: Map<string, number>): Promise<void> {
    const origin = new URL(url).origin
    const wait = (lastRequests.get(origin) ?? 0) + this.requestDelayMs - Date.now()
    if (wait > 0) await delay(wait)
    lastRequests.set(origin, Date.now())
  }
}
