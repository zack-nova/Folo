import { lookup as dnsLookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import type { LookupFunction } from "node:net"
import { BlockList, isIP } from "node:net"
import { Readable } from "node:stream"

import { parseHTML } from "linkedom"

import type { StoredPageChangeSource } from "./page-change-repository"

interface LookupAddress {
  address: string
  family: number
}

export interface PageFetchResult {
  content: string
  etag: string | null
  finalURL: string
  lastModified: string | null
  notModified: boolean
  title: string | null
}

export interface PageFetcherOptions {
  fetchImplementation?: typeof fetch
  lookup?: (hostname: string) => Promise<LookupAddress[]>
  maxBytes: number
  maxContentBytes: number
  timeoutMs: number
}

export class PageFetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const blockedAddresses = new BlockList()
blockedAddresses.addSubnet("0.0.0.0", 8, "ipv4")
blockedAddresses.addSubnet("10.0.0.0", 8, "ipv4")
blockedAddresses.addSubnet("100.64.0.0", 10, "ipv4")
blockedAddresses.addSubnet("127.0.0.0", 8, "ipv4")
blockedAddresses.addSubnet("169.254.0.0", 16, "ipv4")
blockedAddresses.addSubnet("172.16.0.0", 12, "ipv4")
blockedAddresses.addSubnet("192.0.0.0", 24, "ipv4")
blockedAddresses.addSubnet("192.0.2.0", 24, "ipv4")
blockedAddresses.addSubnet("192.168.0.0", 16, "ipv4")
blockedAddresses.addSubnet("198.18.0.0", 15, "ipv4")
blockedAddresses.addSubnet("198.51.100.0", 24, "ipv4")
blockedAddresses.addSubnet("203.0.113.0", 24, "ipv4")
blockedAddresses.addSubnet("224.0.0.0", 4, "ipv4")
blockedAddresses.addSubnet("240.0.0.0", 4, "ipv4")
blockedAddresses.addAddress("::", "ipv6")
blockedAddresses.addAddress("::1", "ipv6")
blockedAddresses.addSubnet("64:ff9b::", 96, "ipv6")
blockedAddresses.addSubnet("64:ff9b:1::", 48, "ipv6")
blockedAddresses.addSubnet("100::", 64, "ipv6")
blockedAddresses.addSubnet("2001::", 23, "ipv6")
blockedAddresses.addSubnet("2002::", 16, "ipv6")
blockedAddresses.addSubnet("fc00::", 7, "ipv6")
blockedAddresses.addSubnet("fe80::", 10, "ipv6")
blockedAddresses.addSubnet("ff00::", 8, "ipv6")

const isPrivateAddress = (address: string): boolean => {
  const family = isIP(address)
  if (family === 4) return blockedAddresses.check(address, "ipv4")
  if (family === 6) return blockedAddresses.check(address, "ipv6")
  return true
}

const boundedBody = async (response: Response, maximumBytes: number): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel()
    throw new PageFetchError("page_too_large", `Page exceeds the ${maximumBytes} byte limit`)
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
      throw new PageFetchError("page_too_large", `Page exceeds the ${maximumBytes} byte limit`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
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
  private readonly fetchImplementation: typeof fetch | null
  private readonly lookup: (hostname: string) => Promise<LookupAddress[]>
  private readonly maxBytes: number
  private readonly maxContentBytes: number
  private readonly timeoutMs: number

  constructor(options: PageFetcherOptions) {
    this.fetchImplementation = options.fetchImplementation ?? null
    this.lookup =
      options.lookup ??
      ((hostname) => dnsLookup(hostname, { all: true }).then((addresses) => [...addresses]))
    this.maxBytes = options.maxBytes
    this.maxContentBytes = options.maxContentBytes
    this.timeoutMs = options.timeoutMs
  }

  async fetch(source: StoredPageChangeSource): Promise<PageFetchResult> {
    let url = new URL(source.targetURL)
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const addresses = await this.assertSafeURL(url)
      const headers = new Headers({
        accept: "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8",
        "accept-encoding": "identity",
        "user-agent": "Folo-Feed-Supplier/1.0 (+page change monitor)",
      })
      if (source.etag) headers.set("if-none-match", source.etag)
      if (source.lastModified) headers.set("if-modified-since", source.lastModified)
      let response: Response
      try {
        response = await this.request(url, headers, addresses)
      } catch (error) {
        if (error instanceof PageFetchError) throw error
        const code =
          error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
            ? "page_fetch_timeout"
            : "page_fetch_failed"
        throw new PageFetchError(
          code,
          code === "page_fetch_timeout" ? "Page request timed out" : "Page request failed",
        )
      }

      if (response.status === 304) {
        return {
          content: "",
          etag: response.headers.get("etag") ?? source.etag,
          finalURL: url.toString(),
          lastModified: response.headers.get("last-modified") ?? source.lastModified,
          notModified: true,
          title: null,
        }
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        if (!location) {
          await response.body?.cancel()
          throw new PageFetchError(
            "page_redirect_invalid",
            `Page redirect ${response.status} has no location`,
          )
        }
        if (redirectCount === 5) {
          await response.body?.cancel()
          throw new PageFetchError("page_redirect_limit", "Page has too many redirects")
        }
        await response.body?.cancel()
        url = new URL(location, url)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new PageFetchError(
          "page_http_error",
          `Page request failed with HTTP ${response.status}`,
        )
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
      if (
        contentType &&
        !contentType.includes("text/html") &&
        !contentType.includes("application/xhtml+xml") &&
        !contentType.includes("text/plain")
      ) {
        await response.body?.cancel()
        throw new PageFetchError("page_content_type_unsupported", "Page must return HTML or text")
      }
      const extracted = extractPageContent(
        await boundedBody(response, this.maxBytes),
        source,
        this.maxContentBytes,
      )
      return {
        ...extracted,
        etag: response.headers.get("etag"),
        finalURL: url.toString(),
        lastModified: response.headers.get("last-modified"),
        notModified: false,
      }
    }
    throw new PageFetchError("page_redirect_limit", "Page has too many redirects")
  }

  private async assertSafeURL(url: URL): Promise<LookupAddress[]> {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new PageFetchError("page_url_invalid", "Page URL must use HTTP or HTTPS")
    }
    if (url.username || url.password) {
      throw new PageFetchError("page_url_invalid", "Page URL must not contain credentials")
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw new PageFetchError(
        "page_private_address",
        "Page URL resolves to a private network address",
      )
    }
    let addresses: LookupAddress[]
    try {
      addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await this.lookup(hostname)
    } catch {
      throw new PageFetchError("page_dns_failed", "Page hostname could not be resolved")
    }
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new PageFetchError(
        "page_private_address",
        "Page URL resolves to a private network address",
      )
    }
    return addresses.map(({ address }) => ({ address, family: isIP(address) }))
  }

  private async request(url: URL, headers: Headers, addresses: LookupAddress[]): Promise<Response> {
    if (this.fetchImplementation) {
      return this.fetchImplementation(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    }

    const lookup: LookupFunction = (_hostname, options, callback) => {
      const requestedFamily =
        options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family
      const eligible = requestedFamily
        ? addresses.filter(({ family }) => family === requestedFamily)
        : addresses
      const selected = eligible[0] ?? addresses[0]
      if (!selected) {
        callback(new Error("No validated page address is available"), "", 0)
        return
      }
      if (options.all) callback(null, eligible.length > 0 ? eligible : addresses)
      else callback(null, selected.address, selected.family)
    }

    return new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          headers: Object.fromEntries(headers.entries()),
          lookup,
          method: "GET",
          signal: AbortSignal.timeout(this.timeoutMs),
        },
        (incoming) => {
          const responseHeaders = new Headers()
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!)
          }
          const status = incoming.statusCode ?? 500
          const body = status === 204 || status === 304 ? null : Readable.toWeb(incoming)
          resolve(
            new Response(body as ReadableStream<Uint8Array> | null, {
              headers: responseHeaders,
              status,
              statusText: incoming.statusMessage,
            }),
          )
        },
      )
      request.once("error", reject)
      request.end()
    })
  }
}
