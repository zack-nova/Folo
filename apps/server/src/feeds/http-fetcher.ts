import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"

import type { FeedFetcher, FetchedFeed } from "./importer"

interface LookupAddress {
  address: string
  family: number
}

export interface HttpFeedFetcherOptions {
  allowPrivateAddresses?: boolean
  fetchImplementation?: typeof fetch
  lookup?: (hostname: string) => Promise<LookupAddress[]>
  maxBytes?: number
  maxRedirects?: number
  timeoutMs?: number
}

const isPrivateIPv4 = (address: string): boolean => {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true
  const [first, second] = parts as [number, number, number, number]
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  )
}

const isPrivateAddress = (address: string): boolean => {
  if (isIP(address) === 4) return isPrivateIPv4(address)
  const normalized = address.toLowerCase()
  if (normalized.startsWith("::ffff:")) return isPrivateIPv4(normalized.slice(7))
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  )
}

const readBoundedBody = async (response: Response, maxBytes: number): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Feed response exceeds the ${maxBytes} byte limit`)
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`Feed response exceeds the ${maxBytes} byte limit`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
}

export class HttpFeedFetcher implements FeedFetcher {
  readonly providerId = "standard_rss" as const
  private readonly allowPrivateAddresses: boolean
  private readonly fetchImplementation: typeof fetch
  private readonly lookup: (hostname: string) => Promise<LookupAddress[]>
  private readonly maxBytes: number
  private readonly maxRedirects: number
  private readonly timeoutMs: number

  constructor(options: HttpFeedFetcherOptions = {}) {
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch
    this.lookup =
      options.lookup ??
      ((hostname) => dnsLookup(hostname, { all: true }).then((addresses) => [...addresses]))
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024
    this.maxRedirects = options.maxRedirects ?? 5
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  providerFor(): "standard_rss" {
    return "standard_rss"
  }

  supports(input: string): boolean {
    try {
      const protocol = new URL(input).protocol
      return protocol === "http:" || protocol === "https:"
    } catch {
      return false
    }
  }

  private async assertSafeURL(url: URL): Promise<void> {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Feed URL must use HTTP or HTTPS")
    }
    if (url.username || url.password) throw new Error("Feed URL must not contain credentials")
    if (this.allowPrivateAddresses) return

    const hostname = url.hostname.toLowerCase()
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw new Error("Feed URL resolves to a private network address")
    }
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await this.lookup(hostname)
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error("Feed URL resolves to a private network address")
    }
  }

  async fetch(
    input: string,
    options: { etag?: string | null; lastModified?: string | null } = {},
  ): Promise<FetchedFeed> {
    let url = new URL(input)

    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      await this.assertSafeURL(url)
      const headers = new Headers({
        accept:
          "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
        "user-agent": "Folo-Self-Hosted/1.0 (+RSS reader)",
      })
      if (options.etag) headers.set("if-none-match", options.etag)
      if (options.lastModified) headers.set("if-modified-since", options.lastModified)
      const response = await this.fetchImplementation(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (response.status >= 300 && response.status < 400) {
        if (response.status === 304) {
          return {
            body: "",
            contentType: response.headers.get("content-type"),
            etag: response.headers.get("etag"),
            lastModified: response.headers.get("last-modified"),
            notModified: true,
            status: response.status,
            url: url.toString(),
          }
        }
        const location = response.headers.get("location")
        if (!location) throw new Error(`Feed redirect ${response.status} has no location`)
        if (redirectCount === this.maxRedirects) throw new Error("Feed has too many redirects")
        url = new URL(location, url)
        continue
      }
      if (!response.ok) throw new Error(`Feed request failed with HTTP ${response.status}`)

      return {
        body: await readBoundedBody(response, this.maxBytes),
        contentType: response.headers.get("content-type"),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        notModified: false,
        status: response.status,
        url: url.toString(),
      }
    }

    throw new Error("Feed has too many redirects")
  }
}
