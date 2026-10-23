import { setTimeout as delay } from "node:timers/promises"

import { parseHTML } from "linkedom"

import { PlatformBehaviorError } from "../platform-behavior-adapter"
import type { SafeHTTPClient } from "../safe-http"
import { decodeBody, SafeHTTPError } from "../safe-http"

// Platform web APIs answer browser requests; the PersonalOS collector scripts used the same agent.
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"

export interface PlatformAdapterOptions {
  client: Pick<SafeHTTPClient, "get">
  requestDelayMs: number
  wait?: (milliseconds: number) => Promise<unknown>
}

export const isoFromSeconds = (value: number | undefined): string | null =>
  value && value > 0 ? new Date(value * 1000).toISOString() : null
export const httpsURL = (value: string | undefined): string =>
  value ? value.replace(/^http:\/\//, "https://").replace(/^\/\//, "https://") : ""
export const text = (value: unknown): string => (typeof value === "string" ? value : "")
export const count = (value: unknown): number => (typeof value === "number" ? value : 0)
export const titleWithin = (value: string, maximum = 300): string => {
  const characters = [...value]
  return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join("")}…`
}
/** Visible text of an HTML fragment, with whitespace collapsed. */
export const plainText = (html: string): string =>
  html
    ? (parseHTML(`<html><body>${html}</body></html>`).document.body.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
    : ""

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})
export const beijingTime = (iso: string | null | undefined): string => {
  if (!iso) return "未知"
  const parts = Object.fromEntries(
    timeFormatter.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

/** A full cookie header is used as given; a bare value is taken to be the platform's login cookie. */
export const cookieHeader = (credential: string, loginCookie: string): string => {
  const value = credential.trim()
  if (/[\r\n]/.test(value))
    throw new PlatformBehaviorError(
      "behavior_credential_invalid",
      "The bound credential must be a single-line cookie",
      400,
    )
  return value.includes("=") ? value : `${loginCookie}=${value}`
}

/**
 * Parses JSON, keeping integers too large for a double as their digits. Zhihu IDs have 19 digits
 * and would otherwise round, which breaks the links built from them.
 */
export const parseJSON = (body: string): unknown =>
  JSON.parse(body, ((_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && context?.source
      ? context.source
      : value) as (key: string, value: unknown) => unknown)

/** The HTTP status a safe request failed with, if it failed on one. */
export const failedStatus = (error: unknown): number | null => {
  const match = error instanceof SafeHTTPError ? /HTTP (\d{3})\b/.exec(error.message) : null
  return match ? Number(match[1]) : null
}

/** Requests of one read: spaced out, counted, and never started past the deadline. */
export class PacedRequests {
  requestCount = 0
  private lastRequestAt = 0
  private readonly wait: (milliseconds: number) => Promise<unknown>
  constructor(
    private readonly options: PlatformAdapterOptions,
    private readonly deadline: number,
  ) {
    this.wait = options.wait ?? ((milliseconds) => delay(milliseconds))
  }
  hasTime(extraMs = 0): boolean {
    return Date.now() + this.options.requestDelayMs + extraMs < this.deadline
  }
  /** Waits before retrying a refused request; the regular spacing still applies after it. */
  async pause(milliseconds: number): Promise<void> {
    await this.wait(milliseconds)
  }
  /** Returns the decoded body; failures are the client's `SafeHTTPError`s. */
  async getText(url: URL, headers: Headers): Promise<string> {
    if (this.lastRequestAt) {
      const remaining = this.lastRequestAt + this.options.requestDelayMs - Date.now()
      if (remaining > 0) await this.wait(remaining)
    }
    this.requestCount++
    try {
      const response = await this.options.client.get(url.toString(), headers)
      return decodeBody(response.bytes, response.headers.get("content-type") ?? "")
    } finally {
      this.lastRequestAt = Date.now()
    }
  }
}

/** A request failure without a platform-specific meaning. */
export const requestFailure = (error: unknown, platform: string): PlatformBehaviorError =>
  new PlatformBehaviorError(
    error instanceof SafeHTTPError
      ? error.code.replace(/^page_/, "behavior_")
      : "behavior_request_failed",
    `${platform} request failed`,
  )
