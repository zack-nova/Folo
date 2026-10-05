import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import type { Duplex } from "node:stream"
import { connect as tlsConnect } from "node:tls"

import { z } from "zod"

/**
 * Thin client for the official Folo API (ADR-0034). It can only reach the endpoints below and
 * authenticates with the owner's session as a cookie: the official API ignores Bearer tokens.
 */
export const OFFICIAL_ENDPOINTS = {
  "entries.list": { method: "POST", path: "/entries" },
  "feeds.get": { method: "GET", path: "/feeds" },
  session: { method: "GET", path: "/better-auth/get-session" },
  "subscriptions.create": { method: "POST", path: "/subscriptions" },
  "subscriptions.delete": { method: "DELETE", path: "/subscriptions" },
  "subscriptions.list": { method: "GET", path: "/subscriptions" },
} as const

export type OfficialEndpoint = keyof typeof OFFICIAL_ENDPOINTS

/** Honest identification; the supplier never presents itself as an official client. */
export const OFFICIAL_USER_AGENT = "Folo-Feed-Supplier/1.0 (+self-hosted; official account owner)"

export interface OfficialHTTPRequest {
  body?: string
  headers: Record<string, string>
  maxBytes: number
  method: string
  timeoutMs: number
  url: URL
}

export interface OfficialHTTPResponse {
  body: string
  headers: Headers
  status: number
}

export type OfficialTransport = (request: OfficialHTTPRequest) => Promise<OfficialHTTPResponse>

/**
 * A failure before any byte of the request reached the official API, such as a refused
 * connection, a rejected proxy tunnel, or a reset during the TLS handshake. Only these are
 * retried, so a write is never sent twice.
 */
export class OfficialConnectionError extends Error {
  constructor(
    message: string,
    readonly requestSent: boolean,
  ) {
    super(message)
  }
}

export type OfficialAPIErrorKind =
  | "auth_invalid"
  | "invalid_response"
  | "plan_denied"
  | "rate_limited"
  | "unavailable"
  | "unsupported_route"

export class OfficialAPIError extends Error {
  constructor(
    readonly kind: OfficialAPIErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message)
  }
}

const tooLarge = (maximumBytes: number) =>
  new OfficialConnectionError(`Official API response exceeds the ${maximumBytes} byte limit`, true)

const readBoundedBody = async (response: Response, maximumBytes: number): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel()
    throw tooLarge(maximumBytes)
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maximumBytes) {
      await reader.cancel()
      throw tooLarge(maximumBytes)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

// Undici reports these when the connection or TLS handshake failed, before the request was sent.
const unsentConnectionCodes = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
])

const fetchFailure = (error: unknown): OfficialConnectionError => {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause
  const code = typeof cause?.code === "string" ? cause.code : null
  const message = typeof cause?.message === "string" ? cause.message : ""
  const requestSent = !(
    (code && unsentConnectionCodes.has(code)) ||
    message.includes("before secure TLS connection was established")
  )
  return new OfficialConnectionError(
    `Official API connection failed${code ? ` (${code})` : ""}`,
    requestSent,
  )
}

/** Direct transport through `fetch`. */
export const fetchTransport =
  (fetchImplementation: typeof fetch = globalThis.fetch): OfficialTransport =>
  async (request) => {
    let response: Response
    try {
      response = await fetchImplementation(request.url, {
        body: request.body,
        headers: request.headers,
        method: request.method,
        redirect: "error",
        signal: AbortSignal.timeout(request.timeoutMs),
      })
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new OfficialConnectionError("Official API request timed out", true)
      }
      throw fetchFailure(error)
    }
    return {
      body: await readBoundedBody(response, request.maxBytes),
      headers: response.headers,
      status: response.status,
    }
  }

const openTunnel = (proxy: URL, target: URL, timeoutMs: number): Promise<Duplex> =>
  new Promise((resolve, reject) => {
    const targetPort = target.port || (target.protocol === "https:" ? "443" : "80")
    const authority = `${target.hostname}:${targetPort}`
    const headers: Record<string, string> = { host: authority }
    if (proxy.username || proxy.password) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      headers["proxy-authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`
    }
    const connect = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
      headers,
      host: proxy.hostname,
      method: "CONNECT",
      path: authority,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      timeout: timeoutMs,
    })
    connect.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(
          new OfficialConnectionError(
            `Proxy refused the tunnel with HTTP ${response.statusCode}`,
            false,
          ),
        )
        return
      }
      if (target.protocol !== "https:") {
        resolve(socket)
        return
      }
      // SNI only carries host names, never addresses.
      const secure = tlsConnect({
        servername: isIP(target.hostname) ? undefined : target.hostname,
        socket,
      })
      secure.once("secureConnect", () => resolve(secure))
      secure.once("error", () => {
        secure.destroy()
        reject(new OfficialConnectionError("TLS handshake through the proxy failed", false))
      })
    })
    connect.once("timeout", () =>
      connect.destroy(new OfficialConnectionError("Proxy tunnel timed out", false)),
    )
    connect.once("error", (error) =>
      reject(
        error instanceof OfficialConnectionError
          ? error
          : new OfficialConnectionError("Proxy connection failed", false),
      ),
    )
    connect.end()
  })

/**
 * Transport through an HTTP CONNECT proxy, used for the official API only. Nodes in mainland
 * China cannot reach it directly.
 */
export const proxyTransport =
  (proxyURL: string): OfficialTransport =>
  async (request) => {
    const proxy = new URL(proxyURL)
    const deadline = Date.now() + request.timeoutMs
    const socket = await openTunnel(proxy, request.url, request.timeoutMs)
    return new Promise((resolve, reject) => {
      // HTTP/1.1 over the tunnel, which is already TLS for https targets. `https.request` would
      // ignore `createConnection` and dial the target directly.
      const outgoing = httpRequest({
        createConnection: () => socket,
        headers: {
          ...request.headers,
          host: request.url.host,
          ...(request.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(request.body)) }),
        },
        host: request.url.hostname,
        method: request.method,
        path: `${request.url.pathname}${request.url.search}`,
        port: request.url.port || (request.url.protocol === "https:" ? 443 : 80),
        timeout: Math.max(deadline - Date.now(), 1),
      })
      outgoing.once("timeout", () =>
        outgoing.destroy(new OfficialConnectionError("Official API request timed out", true)),
      )
      outgoing.once("error", (error) =>
        reject(
          error instanceof OfficialConnectionError
            ? error
            : new OfficialConnectionError("Official API connection failed", true),
        ),
      )
      outgoing.once("response", (response) => {
        const chunks: Buffer[] = []
        let totalBytes = 0
        response.on("data", (chunk: Buffer) => {
          totalBytes += chunk.byteLength
          if (totalBytes > request.maxBytes) {
            response.destroy()
            reject(tooLarge(request.maxBytes))
            return
          }
          chunks.push(chunk)
        })
        response.once("error", () =>
          reject(new OfficialConnectionError("Official API response was interrupted", true)),
        )
        response.once("end", () => {
          // Each tunnel carries one request.
          socket.destroy()
          const headers = new Headers()
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") headers.set(name, value)
            else if (Array.isArray(value)) for (const item of value) headers.append(name, item)
          }
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers,
            status: response.statusCode ?? 0,
          })
        })
      })
      outgoing.end(request.body)
    })
  }

const nullableNumber = z.number().int().nonnegative().nullable().optional()

/** The parts of the official session the supplier relies on; other fields are ignored. */
const officialSessionSchema = z.object({
  feedSubscriptionLimit: nullableNumber,
  role: z.string().max(64).nullable().optional(),
  rsshubSubscriptionLimit: nullableNumber,
  session: z.object({ expiresAt: z.string().max(64).nullable().optional() }),
  user: z.object({ id: z.string().min(1).max(64) }),
})

export interface OfficialSession {
  externalUserId: string
  feedSubscriptionLimit: number | null
  role: string | null
  rssHubSubscriptionLimit: number | null
  sessionExpiresAt: string | null
}

const officialErrorBody = z
  .object({ code: z.number().optional(), message: z.string().optional() })
  .passthrough()

/** Session cookie values are opaque; this only keeps them from breaking the Cookie header. */
export const isOfficialSessionToken = (value: string) =>
  /^[\u0021-\u007E]{16,4096}$/.test(value) && !/[;,"\\]/.test(value)

export interface FoloOfficialClientOptions {
  apiURL: string
  maxBytes?: number
  /** Attempts for failures before the request was sent */
  maxConnectionAttempts?: number
  retryDelayMs?: number
  timeoutMs: number
  transport: OfficialTransport
}

export class FoloOfficialClient {
  private readonly apiURL: URL
  private readonly maxBytes: number
  private readonly maxConnectionAttempts: number
  private readonly retryDelayMs: number

  constructor(private readonly options: FoloOfficialClientOptions) {
    this.apiURL = new URL(`${options.apiURL.replace(/\/$/, "")}/`)
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024
    this.maxConnectionAttempts = options.maxConnectionAttempts ?? 4
    this.retryDelayMs = options.retryDelayMs ?? 500
  }

  /** Validates the session; a rejected or empty session is `auth_invalid`. */
  async getSession(token: string): Promise<OfficialSession> {
    const payload = await this.request("session", token)
    if (payload === null) {
      throw new OfficialAPIError("auth_invalid", "The official session was rejected", 200)
    }
    const parsed = officialSessionSchema.safeParse(payload)
    if (!parsed.success) {
      throw new OfficialAPIError("invalid_response", "The official session response is invalid")
    }
    return {
      externalUserId: parsed.data.user.id,
      feedSubscriptionLimit: parsed.data.feedSubscriptionLimit ?? null,
      role: parsed.data.role ?? null,
      rssHubSubscriptionLimit: parsed.data.rsshubSubscriptionLimit ?? null,
      sessionExpiresAt: parsed.data.session.expiresAt ?? null,
    }
  }

  /** Sends one allow-listed request and returns its parsed JSON body. */
  async request(
    endpoint: OfficialEndpoint,
    token: string,
    input: { body?: unknown; query?: Record<string, string> } = {},
  ): Promise<unknown> {
    if (!isOfficialSessionToken(token)) {
      throw new OfficialAPIError("auth_invalid", "The official session token is malformed")
    }
    const { method, path } = OFFICIAL_ENDPOINTS[endpoint]
    const url = new URL(path.slice(1), this.apiURL)
    for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value)
    const body = input.body === undefined ? undefined : JSON.stringify(input.body)
    const headers: Record<string, string> = {
      accept: "application/json",
      cookie: `__Secure-better-auth.session_token=${token}; better-auth.session_token=${token}`,
      "user-agent": OFFICIAL_USER_AGENT,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    }

    let response: OfficialHTTPResponse | undefined
    for (let attempt = 1; !response; attempt += 1) {
      try {
        response = await this.options.transport({
          body,
          headers,
          maxBytes: this.maxBytes,
          method,
          timeoutMs: this.options.timeoutMs,
          url,
        })
      } catch (error) {
        const connection =
          error instanceof OfficialConnectionError
            ? error
            : new OfficialConnectionError("Official API connection failed", true)
        // Only failures before sending are retried, so writes are never duplicated.
        if (connection.requestSent || attempt >= this.maxConnectionAttempts) {
          throw new OfficialAPIError("unavailable", connection.message)
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt))
      }
    }
    return this.parse(response)
  }

  private parse(response: OfficialHTTPResponse): unknown {
    let payload: unknown
    try {
      payload = response.body ? JSON.parse(response.body) : null
    } catch {
      throw new OfficialAPIError(
        response.status >= 500 ? "unavailable" : "invalid_response",
        `Official API returned a non-JSON response with HTTP ${response.status}`,
        response.status,
      )
    }
    if (response.status >= 200 && response.status < 300) return payload

    const error = officialErrorBody.safeParse(payload)
    const code = error.success ? error.data.code : undefined
    const message = `Official API returned HTTP ${response.status}${code === undefined ? "" : ` (code ${code})`}`
    if (response.status === 401 || response.status === 403) {
      throw new OfficialAPIError("auth_invalid", message, response.status)
    }
    if (response.status === 402) throw new OfficialAPIError("plan_denied", message, 402)
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"))
      throw new OfficialAPIError(
        "rate_limited",
        message,
        429,
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null,
      )
    }
    // Code 2003 is the official "Feed fetch error", returned for unknown RSSHub routes.
    if (response.status === 400 && code === 2003) {
      throw new OfficialAPIError("unsupported_route", message, 400)
    }
    throw new OfficialAPIError(
      response.status >= 500 ? "unavailable" : "invalid_response",
      message,
      response.status,
    )
  }
}
