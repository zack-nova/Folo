import { lookup as dnsLookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import type { LookupFunction } from "node:net"
import { BlockList, isIP } from "node:net"
import { Readable } from "node:stream"

export interface LookupAddress {
  address: string
  family: number
}
export interface SafeHTTPOptions {
  fetchImplementation?: typeof fetch
  lookup?: (hostname: string) => Promise<LookupAddress[]>
  maxBytes: number
  timeoutMs: number
}
export interface SafeHTTPRequestOptions {
  /** Reject a successful response by content type before its body is downloaded. */
  acceptsContentType?: (contentType: string) => boolean
}
export interface SafeHTTPResult {
  status: number
  headers: Headers
  finalURL: string
  bytes: Uint8Array
}

export class SafeHTTPError extends Error {
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

const boundedBody = async (response: Response, maximumBytes: number): Promise<Uint8Array> => {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel()
    throw new SafeHTTPError("page_too_large", `Page exceeds the ${maximumBytes} byte limit`)
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maximumBytes) {
      await reader.cancel()
      throw new SafeHTTPError("page_too_large", `Page exceeds the ${maximumBytes} byte limit`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

export const decodeBody = (bytes: Uint8Array, contentType = ""): string => {
  const prefix = Buffer.from(bytes.subarray(0, 4096)).toString("latin1")
  const charset = /charset\s*=\s*["']?([^\s;"'/>]+)/i
  const meta = prefix.match(/<meta\b[^>]*>/gi)?.find((tag) => charset.test(tag))
  let label = contentType.match(charset)?.[1] ?? meta?.match(charset)?.[1]
  if (!label) {
    label =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : "utf-8"
  }
  if (/^(?:gb2312|gbk|x-gbk)$/i.test(label)) label = "gb18030"
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

export class SafeHTTPClient {
  private readonly fetchImplementation: typeof fetch | null
  private readonly lookup: (hostname: string) => Promise<LookupAddress[]>
  private readonly maxBytes: number
  readonly timeoutMs: number
  constructor(options: SafeHTTPOptions) {
    this.fetchImplementation = options.fetchImplementation ?? null
    this.lookup = options.lookup ?? ((hostname) => dnsLookup(hostname, { all: true }))
    this.maxBytes = options.maxBytes
    this.timeoutMs = options.timeoutMs
  }
  async get(
    input: string,
    headers = new Headers(),
    options: SafeHTTPRequestOptions = {},
  ): Promise<SafeHTTPResult> {
    // One deadline includes DNS, all redirects, and the entire body.
    const deadline = Date.now() + this.timeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.getWithinDeadline(input, headers, deadline, options),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new SafeHTTPError("page_fetch_timeout", "Page request timed out")),
            this.timeoutMs,
          )
        }),
      ])
    } catch (error) {
      if (error instanceof SafeHTTPError) throw error
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new SafeHTTPError("page_fetch_timeout", "Page request timed out")
      }
      throw new SafeHTTPError("page_fetch_failed", "Page request failed")
    } finally {
      clearTimeout(timer)
    }
  }
  private async getWithinDeadline(
    input: string,
    headers: Headers,
    deadline: number,
    options: SafeHTTPRequestOptions,
  ): Promise<SafeHTTPResult> {
    let url = new URL(input)
    headers.set("accept-encoding", "identity")
    for (let redirects = 0; redirects <= 5; redirects++) {
      const addresses = await this.assertSafeURL(url)
      if (Date.now() >= deadline)
        throw new SafeHTTPError("page_fetch_timeout", "Page request timed out")
      const response = await this.request(url, headers, addresses, deadline)
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        await response.body?.cancel()
        const location = response.headers.get("location")
        if (!location)
          throw new SafeHTTPError(
            "page_redirect_invalid",
            `Page redirect ${response.status} has no location`,
          )
        if (redirects === 5)
          throw new SafeHTTPError("page_redirect_limit", "Page has too many redirects")
        url = new URL(location, url)
        continue
      }
      if (!response.ok && response.status !== 304) {
        await response.body?.cancel()
        throw new SafeHTTPError(
          "page_http_error",
          `Page request failed with HTTP ${response.status}`,
        )
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
      if (
        response.status !== 304 &&
        options.acceptsContentType &&
        !options.acceptsContentType(contentType)
      ) {
        await response.body?.cancel()
        return {
          status: response.status,
          headers: response.headers,
          finalURL: url.toString(),
          bytes: new Uint8Array(),
        }
      }
      return {
        status: response.status,
        headers: response.headers,
        finalURL: url.toString(),
        bytes: await boundedBody(response, this.maxBytes),
      }
    }
    throw new SafeHTTPError("page_redirect_limit", "Page has too many redirects")
  }
  private async assertSafeURL(url: URL): Promise<LookupAddress[]> {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SafeHTTPError("page_url_invalid", "Page URL must use HTTP or HTTPS")
    }
    if (url.username || url.password) {
      throw new SafeHTTPError("page_url_invalid", "Page URL must not contain credentials")
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw new SafeHTTPError(
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
      throw new SafeHTTPError("page_dns_failed", "Page hostname could not be resolved")
    }
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new SafeHTTPError(
        "page_private_address",
        "Page URL resolves to a private network address",
      )
    }
    return addresses.map(({ address }) => ({ address, family: isIP(address) }))
  }

  private async request(
    url: URL,
    headers: Headers,
    addresses: LookupAddress[],
    deadline: number,
  ): Promise<Response> {
    if (this.fetchImplementation) {
      return this.fetchImplementation(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
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
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
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
