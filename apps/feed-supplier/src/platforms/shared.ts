import { setTimeout as delay } from "node:timers/promises"

import { parseHTML } from "linkedom"

import type {
  BehaviorObject,
  BehaviorReadRequest,
  BehaviorReadResult,
} from "../platform-behavior-adapter"
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
    // Adapters that call their own service through `run` need no safe HTTP client.
    private readonly options: Omit<PlatformAdapterOptions, "client"> &
      Partial<Pick<PlatformAdapterOptions, "client">>,
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
  /** Runs one platform request after the spacing since the previous one, and counts it. */
  async run<T>(request: () => Promise<T>): Promise<T> {
    if (this.lastRequestAt) {
      const remaining = this.lastRequestAt + this.options.requestDelayMs - Date.now()
      if (remaining > 0) await this.wait(remaining)
    }
    this.requestCount++
    try {
      return await request()
    } finally {
      this.lastRequestAt = Date.now()
    }
  }
  /** Returns the decoded body; failures are the client's `SafeHTTPError`s. */
  async getText(url: URL, headers: Headers): Promise<string> {
    const { client } = this.options
    if (!client) throw new Error("This adapter reads without a safe HTTP client")
    return this.run(async () => {
      const response = await client.get(url.toString(), headers)
      return decodeBody(response.bytes, response.headers.get("content-type") ?? "")
    })
  }
}

/** Pages read after the baseline when every account or item on a page is new. */
const UNTIMED_MAX_PAGES = 3

/**
 * Reads a list that has no platform times (ADR-0037). The baseline reads the whole list, across
 * checks when it runs out of time or the platform pushes back; later reads take the newest pages
 * until they reach objects the source has seen.
 */
export const readUntimedList = async ({
  fetchPage,
  label,
  platform,
  request,
  requests,
}: {
  /** One page from a cursor (null for the start); `nextCursor` is null on the last page */
  fetchPage: (
    cursor: string | null,
  ) => Promise<{ objects: BehaviorObject[]; nextCursor: string | null }>
  /** What the list holds, such as "follows" */
  label: string
  platform: string
  request: BehaviorReadRequest
  requests: PacedRequests
}): Promise<Omit<BehaviorReadResult, "requestCount">> => {
  const baseline = request.knownUntil === null && !request.preview
  const objects = new Map<string, BehaviorObject>()
  const notes: string[] = []
  const result = (nextCursor: string | null, pushedBack?: boolean) => ({
    objects: [...objects.values()],
    notes,
    nextCursor,
    ...(pushedBack ? { pushedBack } : {}),
  })
  let cursor = baseline ? request.cursor : null
  for (let page = 1; ; page++) {
    let fetched: Awaited<ReturnType<typeof fetchPage>>
    try {
      fetched = await fetchPage(cursor)
    } catch (error) {
      // Pages a baseline already read stay read; it continues from here after a pause.
      if (
        baseline &&
        objects.size > 0 &&
        error instanceof PlatformBehaviorError &&
        error.code === "behavior_rate_limited"
      ) {
        notes.push(
          `${platform} restricted the request after ${objects.size} ${label}; the baseline continues later`,
        )
        return result(cursor, true)
      }
      throw error
    }
    for (const object of fetched.objects) objects.set(object.key, object)
    if (fetched.nextCursor === null || !fetched.objects.length || request.preview) break
    cursor = fetched.nextCursor
    if (baseline) {
      if (!requests.hasTime()) {
        notes.push(`The baseline read ${objects.size} ${label} and continues in the next check`)
        return result(cursor)
      }
      continue
    }
    const known = await request.known(fetched.objects.map((object) => object.key))
    if (known.size > 0) break
    if (page === UNTIMED_MAX_PAGES || !requests.hasTime()) {
      notes.push(`Only the newest ${page} pages of ${label} were read`)
      break
    }
  }
  return result(null)
}

/** A request failure without a platform-specific meaning. */
export const requestFailure = (error: unknown, platform: string): PlatformBehaviorError =>
  new PlatformBehaviorError(
    error instanceof SafeHTTPError
      ? error.code.replace(/^page_/, "behavior_")
      : "behavior_request_failed",
    `${platform} request failed`,
  )
