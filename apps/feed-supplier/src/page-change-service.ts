import { createHash, randomUUID } from "node:crypto"

import type { PageChangeEvent, PageChangeSource } from "@follow/feed-source-contracts"
import { pageChangeFeedURL, parsePageChangeSource } from "@follow/feed-source-contracts"

import { createAuditDraft } from "./audit"
import type { StoredPageChangeSource } from "./page-change-repository"
import type { PageFetcher } from "./page-fetcher"
import { PageFetchError } from "./page-fetcher"
import type { SupplierRepository } from "./repository"

export interface CreatePageChangeSourceInput {
  confirmDelaySeconds?: number
  contentSelector?: string | null
  enabled?: boolean
  ignoreSelectors?: string[]
  intervalMinutes?: number | null
  name: string
  targetURL: string
}

export interface UpdatePageChangeSourceInput {
  confirmDelaySeconds?: number
  contentSelector?: string | null
  enabled?: boolean
  ignoreSelectors?: string[]
  intervalMinutes?: number | null
  name?: string
  targetURL?: string
}

export type PageChangeCheckStatus =
  "candidate_pending" | "change_published" | "empty" | "initial_published" | "unchanged"

export interface PageChangeCheckResult {
  event: PageChangeEvent | null
  source: PageChangeSource
  status: PageChangeCheckStatus
}

export interface PageChangeTestResult {
  contentBytes: number
  excerpt: string
  fingerprint: string | null
  finalURL: string
  title: string | null
}

export interface MaterializedPageChangeFeed {
  body: string
  etag: string
  source: PageChangeSource
}

export class PageChangeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
  }
}

const fingerprint = (content: string): string => createHash("sha256").update(content).digest("hex")

const addMilliseconds = (timestamp: string, milliseconds: number): string =>
  new Date(Date.parse(timestamp) + milliseconds).toISOString()

const boundedUTF8 = (value: string, maximumBytes: number, marker: string): string => {
  const encoded = Buffer.from(value)
  if (encoded.byteLength <= maximumBytes) return value
  let end = maximumBytes - Buffer.byteLength(marker)
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) end -= 1
  return `${encoded.subarray(0, end).toString("utf8").trimEnd()}${marker}`
}

const changeDiff = (before: string, after: string): string | null => {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const removed = beforeLines
    .slice(prefix, beforeLines.length - suffix)
    .join("\n")
    .trim()
  const added = afterLines
    .slice(prefix, afterLines.length - suffix)
    .join("\n")
    .trim()
  if (!removed && !added) return null
  return boundedUTF8(
    `Before:\n${removed || "(empty)"}\n\nAfter:\n${added || "(empty)"}`,
    60 * 1024,
    "\n[Diff truncated]",
  )
}

const escapeXML = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

const escapeXMLBounded = (value: string, maximumBytes: number): string => {
  const escaped = escapeXML(value)
  if (Buffer.byteLength(escaped) <= maximumBytes) return escaped
  const marker = "\n[Feed content truncated]"
  let lower = 0
  let upper = value.length
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    const candidate = escapeXML(`${value.slice(0, middle).trimEnd()}${marker}`)
    if (Buffer.byteLength(candidate) <= maximumBytes) lower = middle
    else upper = middle - 1
  }
  return escapeXML(`${value.slice(0, lower).trimEnd()}${marker}`)
}

const publicSource = (source: StoredPageChangeSource): PageChangeSource => {
  const {
    baselineContent: _baselineContent,
    etag: _etag,
    lastModified: _lastModified,
    pendingContent: _pendingContent,
    pendingFirstObservedAt: _pendingFirstObservedAt,
    ...summary
  } = source
  return summary
}

const validateTargetURL = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PageChangeError("page_url_invalid", "Page URL is invalid", 400)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PageChangeError("page_url_invalid", "Page URL must use HTTP or HTTPS", 400)
  }
  if (url.username || url.password) {
    throw new PageChangeError("page_url_invalid", "Page URL must not contain credentials", 400)
  }
  const secretParameter = [...url.searchParams.keys()].find((key) =>
    /^(?:access_?token|api_?key|auth|key|signature|token)$/i.test(key),
  )
  if (secretParameter) {
    throw new PageChangeError(
      "page_url_secret_forbidden",
      `Page URL must not contain the secret query parameter ${secretParameter}`,
      400,
    )
  }
  url.hash = ""
  return url.toString()
}

const nextRegularCheck = (source: StoredPageChangeSource, now: string): string | null =>
  source.enabled && source.intervalMinutes
    ? addMilliseconds(now, source.intervalMinutes * 60_000)
    : null

const failureDelay = (source: StoredPageChangeSource): number => {
  const ceiling = Math.max((source.intervalMinutes ?? 360) * 60_000, 6 * 60 * 60_000)
  return Math.min(15 * 60_000 * 2 ** source.consecutiveFailures, ceiling, 24 * 60 * 60_000)
}

export class PageChangeService {
  private readonly activeChecks = new Set<string>()

  constructor(
    private readonly repository: SupplierRepository,
    private readonly fetcher: PageFetcher,
  ) {}

  async listSources(): Promise<PageChangeSource[]> {
    return (await this.repository.listPageChangeSources()).map(publicSource)
  }

  async getSource(id: string): Promise<PageChangeSource | null> {
    const source = await this.repository.findPageChangeSource(id)
    return source ? publicSource(source) : null
  }

  async listEvents(id: string, limit: number): Promise<PageChangeEvent[] | null> {
    if (!(await this.repository.findPageChangeSource(id))) return null
    return this.repository.listPageChangeEvents(id, limit)
  }

  async createSource(input: CreatePageChangeSourceInput, actor: string): Promise<PageChangeSource> {
    const now = new Date().toISOString()
    const id = randomUUID()
    const enabled = input.enabled ?? false
    const intervalMinutes = input.intervalMinutes ?? null
    const source: StoredPageChangeSource = {
      baselineContent: null,
      baselineFingerprint: null,
      baselineObservedAt: null,
      confirmDelaySeconds: input.confirmDelaySeconds ?? 300,
      consecutiveFailures: 0,
      contentSelector: input.contentSelector ?? null,
      createdAt: now,
      deletedAt: null,
      enabled,
      etag: null,
      eventCount: 0,
      feedURL: pageChangeFeedURL(id),
      id,
      ignoreSelectors: input.ignoreSelectors ?? [],
      intervalMinutes,
      lastAttemptAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      lastModified: null,
      lastSuccessAt: null,
      name: input.name,
      nextCheckAt: enabled && intervalMinutes ? now : null,
      pendingConfirmAfter: null,
      pendingContent: null,
      pendingFingerprint: null,
      pendingFirstObservedAt: null,
      targetURL: validateTargetURL(input.targetURL),
      updatedAt: now,
    }
    const created = await this.repository.createPageChangeSource(
      source,
      createAuditDraft(actor, "page_source.created", "page_source", id, {
        enabled,
        intervalMinutes,
        name: source.name,
      }),
    )
    return publicSource(created)
  }

  async updateSource(
    id: string,
    input: UpdatePageChangeSourceInput,
    actor: string,
  ): Promise<PageChangeSource | null> {
    const current = await this.repository.findPageChangeSource(id)
    if (!current) return null
    const now = new Date().toISOString()
    const targetURL = input.targetURL ? validateTargetURL(input.targetURL) : current.targetURL
    const contentSelector =
      input.contentSelector === undefined ? current.contentSelector : input.contentSelector
    const ignoreSelectors = input.ignoreSelectors ?? current.ignoreSelectors
    const extractionChanged =
      targetURL !== current.targetURL ||
      contentSelector !== current.contentSelector ||
      JSON.stringify(ignoreSelectors) !== JSON.stringify(current.ignoreSelectors)
    const enabled = input.enabled ?? current.enabled
    const intervalMinutes =
      input.intervalMinutes === undefined ? current.intervalMinutes : input.intervalMinutes
    const schedulingChanged =
      enabled !== current.enabled ||
      intervalMinutes !== current.intervalMinutes ||
      extractionChanged
    const updated: StoredPageChangeSource = {
      ...current,
      ...(extractionChanged
        ? {
            baselineContent: null,
            baselineFingerprint: null,
            baselineObservedAt: null,
            etag: null,
            lastModified: null,
            pendingConfirmAfter: null,
            pendingContent: null,
            pendingFingerprint: null,
            pendingFirstObservedAt: null,
          }
        : {}),
      ...(!enabled
        ? {
            pendingConfirmAfter: null,
            pendingContent: null,
            pendingFingerprint: null,
            pendingFirstObservedAt: null,
          }
        : {}),
      confirmDelaySeconds: input.confirmDelaySeconds ?? current.confirmDelaySeconds,
      contentSelector,
      enabled,
      ignoreSelectors,
      intervalMinutes,
      name: input.name ?? current.name,
      nextCheckAt:
        enabled && intervalMinutes ? (schedulingChanged ? now : current.nextCheckAt) : null,
      targetURL,
      updatedAt: now,
    }
    const result = await this.repository.updatePageChangeSource(
      updated,
      createAuditDraft(actor, "page_source.updated", "page_source", id, {
        enabled,
        intervalMinutes,
        name: updated.name,
        resetBaseline: extractionChanged,
      }),
    )
    return result ? publicSource(result) : null
  }

  async deleteSource(id: string, actor: string): Promise<boolean> {
    const deletedAt = new Date().toISOString()
    return Boolean(
      await this.repository.softDeletePageChangeSource(
        id,
        deletedAt,
        createAuditDraft(actor, "page_source.deleted", "page_source", id, {}),
      ),
    )
  }

  async testSource(id: string, actor: string): Promise<PageChangeTestResult | null> {
    const source = await this.repository.findPageChangeSource(id)
    if (!source) return null
    try {
      const result = await this.fetcher.fetch({ ...source, etag: null, lastModified: null })
      const contentFingerprint = result.content ? fingerprint(result.content) : null
      await this.repository.recordAudit(
        createAuditDraft(actor, "page_source.tested", "page_source", id, {
          contentBytes: Buffer.byteLength(result.content),
          succeeded: true,
        }),
      )
      return {
        contentBytes: Buffer.byteLength(result.content),
        excerpt: result.content.slice(0, 500),
        fingerprint: contentFingerprint,
        finalURL: result.finalURL,
        title: result.title,
      }
    } catch (error) {
      await this.repository.recordAudit(
        createAuditDraft(actor, "page_source.tested", "page_source", id, { succeeded: false }),
      )
      throw this.publicError(error)
    }
  }

  async checkSource(id: string, now = new Date()): Promise<PageChangeCheckResult | null> {
    const source = await this.repository.findPageChangeSource(id)
    if (!source) return null
    if (this.activeChecks.has(id)) {
      throw new PageChangeError(
        "page_check_in_progress",
        "Page source is already being checked",
        409,
      )
    }
    this.activeChecks.add(id)
    try {
      return await this.performCheck(source, now.toISOString())
    } finally {
      this.activeChecks.delete(id)
    }
  }

  async runDueCycle(now = new Date(), limit = 25): Promise<{ checked: number; failed: number }> {
    const sources = await this.repository.listDuePageChangeSources(now.toISOString(), limit)
    let failed = 0
    for (const source of sources) {
      try {
        await this.checkSource(source.id, now)
      } catch {
        failed += 1
      }
    }
    return { checked: sources.length, failed }
  }

  async materializeFeed(input: string): Promise<MaterializedPageChangeFeed> {
    const parsed = parsePageChangeSource(input)
    const stored = await this.repository.findPageChangeSource(parsed.sourceId)
    if (!stored) {
      throw new PageChangeError("page_source_not_found", "Page change source was not found", 404)
    }
    const events = await this.repository.listPageChangeEvents(stored.id, 50)
    const etag = `"page-change-${createHash("sha256")
      .update(
        `${stored.id}:${stored.name}:${stored.targetURL}:${events[0]?.guid ?? "empty"}:${events.length}`,
      )
      .digest("hex")
      .slice(0, 24)}"`
    const items = events
      .map((event) => {
        const body = boundedUTF8(
          event.diff
            ? `Change summary:\n${event.diff}\n\nCurrent content:\n${event.content}`
            : event.content,
          64 * 1024,
          "\n[Feed content truncated]",
        )
        return `<item>
  <guid isPermaLink="false">${escapeXML(event.guid)}</guid>
  <title>${escapeXML(event.title)}</title>
  <link>${escapeXML(stored.targetURL)}</link>
  <pubDate>${new Date(event.publishedAt).toUTCString()}</pubDate>
  <category>page-change</category>
  <description>${escapeXMLBounded(event.diff ?? event.content, 4 * 1024)}</description>
  <content:encoded>${escapeXMLBounded(body, 64 * 1024)}</content:encoded>
</item>`
      })
      .join("\n")
    return {
      body: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
<title>${escapeXML(stored.name)}</title>
<link>${escapeXML(stored.targetURL)}</link>
<description>${escapeXML(`Page changes for ${stored.name}`)}</description>
<lastBuildDate>${new Date(events[0]?.publishedAt ?? stored.createdAt).toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>`,
      etag,
      source: publicSource(stored),
    }
  }

  private async performCheck(
    source: StoredPageChangeSource,
    now: string,
  ): Promise<PageChangeCheckResult> {
    try {
      const fetched = await this.fetcher.fetch(source)
      const content = fetched.notModified
        ? (source.pendingContent ?? source.baselineContent ?? "")
        : fetched.content
      if (!content) {
        const empty = await this.repository.savePageChangeObservation(
          {
            ...source,
            consecutiveFailures: 0,
            etag: fetched.etag,
            lastAttemptAt: now,
            lastErrorCode: null,
            lastErrorSummary: null,
            lastModified: fetched.lastModified,
            lastSuccessAt: now,
            nextCheckAt: nextRegularCheck(source, now),
            pendingConfirmAfter: null,
            pendingContent: null,
            pendingFingerprint: null,
            pendingFirstObservedAt: null,
            updatedAt: now,
          },
          null,
        )
        return { event: null, source: publicSource(empty), status: "empty" }
      }

      const observedFingerprint = fetched.notModified
        ? (source.pendingFingerprint ?? source.baselineFingerprint ?? fingerprint(content))
        : fingerprint(content)
      let event: PageChangeEvent | null = null
      let status: PageChangeCheckStatus
      let updated: StoredPageChangeSource

      if (!source.baselineFingerprint) {
        event = this.createEvent(source, content, observedFingerprint, now, null)
        status = "initial_published"
        updated = this.acceptedSource(source, fetched, content, observedFingerprint, now)
      } else if (observedFingerprint === source.baselineFingerprint) {
        status = "unchanged"
        updated = {
          ...this.successfulSource(source, fetched, now),
          nextCheckAt: nextRegularCheck(source, now),
          pendingConfirmAfter: null,
          pendingContent: null,
          pendingFingerprint: null,
          pendingFirstObservedAt: null,
        }
      } else if (
        observedFingerprint === source.pendingFingerprint &&
        source.pendingConfirmAfter &&
        Date.parse(now) >= Date.parse(source.pendingConfirmAfter)
      ) {
        event = this.createEvent(
          source,
          content,
          observedFingerprint,
          now,
          source.baselineFingerprint,
        )
        status = "change_published"
        updated = this.acceptedSource(source, fetched, content, observedFingerprint, now)
      } else if (observedFingerprint === source.pendingFingerprint) {
        status = "candidate_pending"
        updated = {
          ...this.successfulSource(source, fetched, now),
          nextCheckAt: source.pendingConfirmAfter,
        }
      } else {
        const confirmAfter = addMilliseconds(now, source.confirmDelaySeconds * 1_000)
        status = "candidate_pending"
        updated = {
          ...this.successfulSource(source, fetched, now),
          nextCheckAt: source.enabled ? confirmAfter : null,
          pendingConfirmAfter: confirmAfter,
          pendingContent: content,
          pendingFingerprint: observedFingerprint,
          pendingFirstObservedAt: now,
        }
      }

      const persisted = await this.repository.savePageChangeObservation(updated, event)
      return { event, source: publicSource(persisted), status }
    } catch (error) {
      const publicError = this.publicError(error)
      const failed: StoredPageChangeSource = {
        ...source,
        consecutiveFailures: source.consecutiveFailures + 1,
        lastAttemptAt: now,
        lastErrorCode: publicError.code,
        lastErrorSummary: publicError.message.slice(0, 500),
        nextCheckAt:
          source.enabled && source.intervalMinutes
            ? addMilliseconds(now, failureDelay(source))
            : null,
        updatedAt: now,
      }
      await this.repository.savePageChangeObservation(failed, null)
      throw publicError
    }
  }

  private successfulSource(
    source: StoredPageChangeSource,
    fetched: Awaited<ReturnType<PageFetcher["fetch"]>>,
    now: string,
  ): StoredPageChangeSource {
    return {
      ...source,
      consecutiveFailures: 0,
      etag: fetched.etag,
      lastAttemptAt: now,
      lastErrorCode: null,
      lastErrorSummary: null,
      lastModified: fetched.lastModified,
      lastSuccessAt: now,
      updatedAt: now,
    }
  }

  private acceptedSource(
    source: StoredPageChangeSource,
    fetched: Awaited<ReturnType<PageFetcher["fetch"]>>,
    content: string,
    contentFingerprint: string,
    now: string,
  ): StoredPageChangeSource {
    return {
      ...this.successfulSource(source, fetched, now),
      baselineContent: content,
      baselineFingerprint: contentFingerprint,
      baselineObservedAt: now,
      nextCheckAt: nextRegularCheck(source, now),
      pendingConfirmAfter: null,
      pendingContent: null,
      pendingFingerprint: null,
      pendingFirstObservedAt: null,
    }
  }

  private createEvent(
    source: StoredPageChangeSource,
    content: string,
    afterFingerprint: string,
    now: string,
    beforeFingerprint: string | null,
  ): PageChangeEvent {
    const id = randomUUID()
    return {
      afterFingerprint,
      beforeFingerprint,
      content,
      diff: source.baselineContent ? changeDiff(source.baselineContent, content) : null,
      guid: `urn:folo:page-change:${source.id}:${id}`,
      id,
      publishedAt: now,
      sourceId: source.id,
      title: `${source.name} changed`,
    }
  }

  private publicError(error: unknown): PageChangeError {
    if (error instanceof PageChangeError) return error
    if (error instanceof PageFetchError) return new PageChangeError(error.code, error.message, 502)
    return new PageChangeError("page_check_failed", "Page check failed", 502)
  }
}

export const startPageChangeScheduler = ({
  service,
  pollIntervalMs,
  onCycle,
}: {
  service: PageChangeService
  pollIntervalMs: number
  onCycle?: (result: { checked: number; failed: number }) => void
}) => {
  let activeRun: Promise<void> | null = null
  const scheduleRun = () => {
    if (activeRun) return
    activeRun = service
      .runDueCycle()
      .then(onCycle)
      .finally(() => {
        activeRun = null
      })
  }
  const timer = setInterval(scheduleRun, pollIntervalMs)
  timer.unref()
  scheduleRun()
  return async () => {
    clearInterval(timer)
    await activeRun
  }
}
