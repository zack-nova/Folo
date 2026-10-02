import type {
  WebListCheckResult,
  WebListItem,
  WebListSource,
  WebListTestResult,
} from "@follow/feed-source-contracts"
import { z } from "zod"

export interface WebListManagementOptions {
  baseURL: string
  fetchImplementation?: typeof fetch
  timeoutMs?: number
  token: string
}

/** A supplier response that the core relays to the owner with the same status. */
export class WebListManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

// The supplier truncates titles and facts by Unicode code point, not by UTF-16 unit.
const codePoints = (maximum: number) =>
  z.string().refine((value) => [...value].length <= maximum, `At most ${maximum} characters`)
const timestamp = z.string().max(64)
const nullableTimestamp = timestamp.nullable()
const selector = z.string().max(512).nullable()
const path = z.string().max(512).nullable()
const patterns = z.array(z.string().max(256)).max(16)

// Strict schemas: only contract fields ever reach the browser, whatever the supplier returns.
const webListSource = z
  .object({
    consecutiveFailures: z.number().int().min(0),
    createdAt: timestamp,
    deletedAt: nullableTimestamp,
    detail: z
      .object({
        contentSelectors: z.array(z.string().max(512)).max(16),
        enabled: z.boolean(),
        ignoreSelectors: z.array(z.string().max(512)).max(16),
      })
      .strict(),
    enabled: z.boolean(),
    feedURL: z.string().regex(/^weblist:\/\/[\da-f-]{36}$/),
    filters: z
      .object({
        excludeTextPatterns: patterns,
        excludeURLPatterns: patterns,
        includeTextPatterns: patterns,
        includeURLPatterns: patterns,
      })
      .strict(),
    format: z.enum(["html", "json"]),
    html: z
      .object({
        dateSelector: selector,
        itemSelector: selector,
        linkSelector: selector,
        summarySelector: selector,
        titleSelector: selector,
      })
      .strict()
      .nullable(),
    id: z.uuid(),
    intervalMinutes: z.number().int().nullable(),
    itemCount: z.number().int().min(0),
    json: z
      .object({
        idPath: path,
        itemsPath: z.string().max(512),
        metadataPaths: z.record(z.string().max(32), z.string().max(512)),
        publishedAtFormat: z.enum(["auto", "unix_milliseconds", "unix_seconds"]),
        publishedAtPath: path,
        summaryPath: path,
        titlePath: z.string().max(512),
        urlBase: z.string().max(2_048).nullable(),
        urlPath: path,
        urlTemplate: z.string().max(2_048).nullable(),
      })
      .strict()
      .nullable(),
    lastAttemptAt: nullableTimestamp,
    lastErrorCode: z.string().max(64).nullable(),
    lastErrorSummary: z.string().max(500).nullable(),
    lastSuccessAt: nullableTimestamp,
    maxItems: z.number().int(),
    maxPages: z.number().int(),
    name: z.string().max(128),
    nextCheckAt: nullableTimestamp,
    targetURL: z.string().max(2_048),
    timeZone: z.string().max(64),
    updatedAt: timestamp,
  })
  .strict()
const webListItem = z
  .object({
    content: z.string().nullable(),
    detailStatus: z.enum(["failed", "fetched", "skipped"]),
    discoveredAt: timestamp,
    guid: z.string().max(160),
    id: z.uuid(),
    publishedAt: nullableTimestamp,
    sourceId: z.uuid(),
    summary: z.string().nullable(),
    title: codePoints(300),
    url: z.string().max(2_048),
  })
  .strict()
const webListTest = z
  .object({
    detail: z
      .object({
        content: z.string().nullable(),
        detailStatus: z.enum(["failed", "fetched", "skipped"]),
        publishedAt: nullableTimestamp,
        title: codePoints(300),
      })
      .strict()
      .nullable(),
    finalURL: z.string().max(2_048),
    items: z
      .array(
        z
          .object({
            metadata: z.array(z.tuple([z.string().max(32), codePoints(256)])).max(12),
            publishedAt: nullableTimestamp,
            summary: z.string().nullable(),
            title: codePoints(300),
            url: z.string().max(2_048),
          })
          .strict(),
      )
      .max(20),
    pagesRead: z.number().int().min(0),
  })
  .strict()
const webListCheck = z
  .object({
    publishedCount: z.number().int().min(0),
    source: webListSource,
    status: z.enum(["items_published", "unchanged"]),
  })
  .strict()
const sourceEnvelope = z.object({ source: webListSource }).strict()

/**
 * Owner-scoped client for the supplier's web list management API. It holds the management
 * token, which cannot reach credentials, catalog bindings, audit or feed endpoints.
 */
export class WebListManagementClient {
  private readonly baseURL: string
  private readonly fetchImplementation: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly options: WebListManagementOptions) {
    // No trailing slash: Fastify routes /web-list-sources and /web-list-sources/ differently.
    this.baseURL = `${options.baseURL.replace(/\/$/, "")}/v1/manage/web-list-sources`
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch
    // Checks fetch detail pages and may take up to the supplier's two minute detail budget.
    this.timeoutMs = options.timeoutMs ?? 150_000
  }

  async list(actor: string): Promise<WebListSource[]> {
    return z
      .object({ sources: z.array(webListSource) })
      .strict()
      .parse(await this.request(actor, "GET", "")).sources
  }

  async get(actor: string, id: string): Promise<WebListSource> {
    return sourceEnvelope.parse(await this.request(actor, "GET", this.idPath(id))).source
  }

  async create(actor: string, body: unknown): Promise<WebListSource> {
    return sourceEnvelope.parse(await this.request(actor, "POST", "", body)).source
  }

  async update(actor: string, id: string, body: unknown): Promise<WebListSource> {
    return sourceEnvelope.parse(await this.request(actor, "PATCH", this.idPath(id), body)).source
  }

  async delete(actor: string, id: string): Promise<void> {
    await this.request(actor, "DELETE", this.idPath(id))
  }

  async test(actor: string, id: string, detail: boolean): Promise<WebListTestResult> {
    return webListTest.parse(
      await this.request(actor, "POST", `${this.idPath(id)}/test?detail=${detail}`),
    )
  }

  async check(actor: string, id: string): Promise<WebListCheckResult> {
    return webListCheck.parse(await this.request(actor, "POST", `${this.idPath(id)}/check`))
  }

  async items(actor: string, id: string, limit: number): Promise<WebListItem[]> {
    return z
      .object({ items: z.array(webListItem) })
      .strict()
      .parse(await this.request(actor, "GET", `${this.idPath(id)}/items?limit=${limit}`)).items
  }

  private idPath(id: string): string {
    if (!z.uuid().safeParse(id).success) {
      throw new WebListManagementError(
        "web_list_source_not_found",
        "Web list source was not found",
        404,
      )
    }
    return id
  }

  private async request(
    actor: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.fetchImplementation(
      new URL(path ? `${this.baseURL}/${path}` : this.baseURL),
      {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "x-folo-actor": actor,
        },
        method,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    )
    if (response.status === 204) return null
    const payload = (await response.json().catch(() => null)) as {
      code?: unknown
      message?: unknown
    } | null
    if (!response.ok) {
      throw new WebListManagementError(
        typeof payload?.code === "string" ? payload.code.slice(0, 64) : "web_list_request_failed",
        typeof payload?.message === "string"
          ? payload.message.slice(0, 500)
          : `Feed supplier request failed with HTTP ${response.status}`,
        response.status,
      )
    }
    return payload
  }
}
