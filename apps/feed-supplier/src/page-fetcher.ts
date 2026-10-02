import { parseHTML } from "linkedom"

import type { StoredPageChangeSource } from "./page-change-repository"
import type { SafeHTTPOptions } from "./safe-http"
import { decodeBody, SafeHTTPClient, SafeHTTPError as PageFetchError } from "./safe-http"
export { SafeHTTPError as PageFetchError } from "./safe-http"
export interface PageFetchResult {
  content: string
  etag: string | null
  finalURL: string
  lastModified: string | null
  notModified: boolean
  title: string | null
}
export interface PageFetcherOptions extends SafeHTTPOptions {
  maxContentBytes: number
}
const normalizeText = (value: string): string =>
  value
    .normalize("NFC")
    .replaceAll("\u00a0", " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim()

const truncateUTF8 = (value: string, maximumBytes: number): string => {
  const encoded = Buffer.from(value)
  if (encoded.byteLength <= maximumBytes) return value
  const marker = "\n[Content truncated]"
  let end = maximumBytes - Buffer.byteLength(marker)
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) end -= 1
  return `${encoded.subarray(0, end).toString("utf8").trimEnd()}${marker}`
}

export const extractPageContent = (
  html: string,
  source: Pick<StoredPageChangeSource, "contentSelector" | "ignoreSelectors">,
  maximumBytes: number,
): { content: string; title: string | null } => {
  const { document } = parseHTML(html)
  for (const selector of ["script", "style", "noscript", "template", ...source.ignoreSelectors]) {
    let matches: NodeListOf<Element>
    try {
      matches = document.querySelectorAll(selector)
    } catch {
      throw new PageFetchError("invalid_selector", `Invalid CSS selector: ${selector}`)
    }
    for (const match of matches) match.remove()
  }

  let root: Element | null
  try {
    root = source.contentSelector
      ? document.querySelector(source.contentSelector)
      : (document.querySelector("main, article, [role='main']") ?? document.body)
  } catch {
    throw new PageFetchError(
      "invalid_selector",
      `Invalid CSS selector: ${source.contentSelector ?? ""}`,
    )
  }
  if (!root) {
    throw new PageFetchError("content_selector_not_found", "The configured content was not found")
  }
  const content = truncateUTF8(normalizeText(root.textContent ?? ""), maximumBytes)
  const title = normalizeText(document.title ?? "") || null
  return { content, title }
}

export class PageFetcher {
  private readonly client: SafeHTTPClient
  constructor(private readonly options: PageFetcherOptions) {
    this.client = new SafeHTTPClient(options)
  }
  async fetch(source: StoredPageChangeSource): Promise<PageFetchResult> {
    const headers = new Headers({
      accept: "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8",
      "user-agent": "Folo-Feed-Supplier/1.0 (+page change monitor)",
    })
    if (source.etag) headers.set("if-none-match", source.etag)
    if (source.lastModified) headers.set("if-modified-since", source.lastModified)
    const response = await this.client.get(source.targetURL, headers)
    const notModified = response.status === 304
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
    if (
      !notModified &&
      contentType &&
      !/text\/html|application\/xhtml\+xml|text\/plain/.test(contentType)
    ) {
      throw new PageFetchError("page_content_type_unsupported", "Page must return HTML or text")
    }
    return {
      ...(notModified
        ? { content: "", title: null }
        : extractPageContent(
            decodeBody(response.bytes, contentType),
            source,
            this.options.maxContentBytes,
          )),
      etag: response.headers.get("etag") ?? (notModified ? source.etag : null),
      lastModified:
        response.headers.get("last-modified") ?? (notModified ? source.lastModified : null),
      finalURL: response.finalURL,
      notModified,
    }
  }
}
