import { createHash, randomUUID } from "node:crypto"

import type { WebListItem, WebListSource } from "@follow/feed-source-contracts"
import { parseWebListSource, webListFeedURL } from "@follow/feed-source-contracts"
import { parseHTML } from "linkedom"

import { createAuditDraft } from "./audit"
import type { SupplierRepository } from "./repository"
import { SafeHTTPError } from "./safe-http"
import { boundedUTF8, escapeXML, WebListError } from "./web-list-extraction"
import type { WebListFetcher } from "./web-list-fetcher"
import type { StoredWebListItem, StoredWebListSource } from "./web-list-repository"
import type { CreateWebListSourceInput, UpdateWebListSourceInput } from "./web-list-validation"
import { validateWebListInput } from "./web-list-validation"
export { WebListError } from "./web-list-extraction"

const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex")
const publicSource = ({
  etag: _etag,
  lastModified: _lastModified,
  ...source
}: StoredWebListSource): WebListSource => source
const publicItem = ({ itemKey: _itemKey, ...item }: StoredWebListItem): WebListItem => item
const nextCheck = (
  source: StoredWebListSource,
  now: string,
  delay = (source.intervalMinutes ?? 0) * 60000,
) =>
  source.enabled && source.intervalMinutes ? new Date(Date.parse(now) + delay).toISOString() : null
const publicError = (error: unknown): WebListError =>
  error instanceof WebListError
    ? error
    : error instanceof SafeHTTPError
      ? new WebListError(error.code.replace(/^page_/, "web_list_"), error.message, 502)
      : new WebListError("web_list_check_failed", "Web list check failed", 502)
export const WEB_LIST_DETAIL_BUDGET_MS = 120000

export class WebListService {
  private readonly activeChecks = new Set<string>()
  constructor(
    private readonly repository: SupplierRepository,
    private readonly fetcher: WebListFetcher,
  ) {}
  async listSources(): Promise<WebListSource[]> {
    return (await this.repository.listWebListSources()).map(publicSource)
  }
  async getSource(id: string): Promise<WebListSource | null> {
    const source = await this.repository.findWebListSource(id)
    return source ? publicSource(source) : null
  }
  async listItems(id: string, limit: number): Promise<WebListItem[] | null> {
    return (await this.repository.findWebListSource(id))
      ? (await this.repository.listWebListItems(id, limit)).map(publicItem)
      : null
  }
  async createSource(input: CreateWebListSourceInput, actor: string): Promise<WebListSource> {
    const fields = validateWebListInput(input)
    const now = new Date().toISOString()
    const id = randomUUID()
    const source: StoredWebListSource = {
      ...fields,
      id,
      feedURL: webListFeedURL(id),
      itemCount: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      etag: null,
      lastModified: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      consecutiveFailures: 0,
      nextCheckAt: fields.enabled && fields.intervalMinutes ? now : null,
    }
    return publicSource(
      await this.repository.createWebListSource(
        source,
        createAuditDraft(actor, "web_list_source.created", "web_list_source", id, {
          name: source.name,
          enabled: source.enabled,
          intervalMinutes: source.intervalMinutes,
        }),
      ),
    )
  }
  async updateSource(
    id: string,
    input: UpdateWebListSourceInput,
    actor: string,
  ): Promise<WebListSource | null> {
    this.assertIdle(id)
    const source = await this.repository.findWebListSource(id)
    if (!source) return null
    const fields = validateWebListInput({
      name: source.name,
      targetURL: source.targetURL,
      format: source.format,
      html: source.html,
      json: source.json,
      filters: source.filters,
      detail: source.detail,
      maxItems: source.maxItems,
      maxPages: source.maxPages,
      timeZone: source.timeZone,
      enabled: source.enabled,
      intervalMinutes: source.intervalMinutes,
      ...input,
    })
    const now = new Date().toISOString()
    const extractionChanged = [
      "targetURL",
      "format",
      "html",
      "json",
      "filters",
      "maxItems",
      "maxPages",
      "timeZone",
    ].some(
      (key) =>
        JSON.stringify(fields[key as keyof typeof fields]) !==
        JSON.stringify(source[key as keyof StoredWebListSource]),
    )
    const schedulingChanged =
      extractionChanged ||
      fields.enabled !== source.enabled ||
      fields.intervalMinutes !== source.intervalMinutes
    const updated: StoredWebListSource = {
      ...source,
      ...fields,
      updatedAt: now,
      etag: extractionChanged ? null : source.etag,
      lastModified: extractionChanged ? null : source.lastModified,
      nextCheckAt:
        fields.enabled && fields.intervalMinutes
          ? schedulingChanged
            ? now
            : source.nextCheckAt
          : null,
    }
    const saved = await this.repository.updateWebListSource(
      updated,
      createAuditDraft(actor, "web_list_source.updated", "web_list_source", id, {
        name: updated.name,
        enabled: updated.enabled,
        resetCache: extractionChanged,
      }),
    )
    return saved ? publicSource(saved) : null
  }
  async deleteSource(id: string, actor: string): Promise<boolean> {
    this.assertIdle(id)
    return Boolean(
      await this.repository.softDeleteWebListSource(
        id,
        new Date().toISOString(),
        createAuditDraft(actor, "web_list_source.deleted", "web_list_source", id, {}),
      ),
    )
  }
  async testSource(id: string, actor: string, detail = false) {
    const source = await this.repository.findWebListSource(id)
    if (!source) return null
    try {
      const fetched = await this.fetcher.fetch({ ...source, etag: null, lastModified: null })
      const first = fetched.items[0]
      const preview = detail && first ? await this.fetcher.detail(first, source) : null
      await this.repository.recordAudit(
        createAuditDraft(actor, "web_list_source.tested", "web_list_source", id, {
          succeeded: true,
          extractedCount: fetched.items.length,
        }),
      )
      return {
        finalURL: fetched.finalURL,
        pagesRead: fetched.pagesRead,
        items: fetched.items.slice(0, 20).map(({ identity: _identity, ...item }) => item),
        detail: preview
          ? { ...preview, content: preview.content ? boundedUTF8(preview.content, 4096) : null }
          : null,
      }
    } catch (error) {
      await this.repository.recordAudit(
        createAuditDraft(actor, "web_list_source.tested", "web_list_source", id, {
          succeeded: false,
        }),
      )
      throw publicError(error)
    }
  }
  private assertIdle(id: string): void {
    if (this.activeChecks.has(id))
      throw new WebListError(
        "web_list_check_in_progress",
        "Web list source is already being checked",
        409,
      )
  }
  async checkSource(id: string, now = new Date()) {
    this.assertIdle(id)
    this.activeChecks.add(id)
    try {
      const source = await this.repository.findWebListSource(id)
      return source ? await this.performCheck(source, now) : null
    } finally {
      this.activeChecks.delete(id)
    }
  }
  private async performCheck(source: StoredWebListSource, date: Date) {
    const now = date.toISOString()
    try {
      const fetched = await this.fetcher.fetch(source, date)
      if (!fetched.notModified && !fetched.items.length)
        throw new WebListError("web_list_no_items", "No items were extracted", 502)
      const candidates = fetched.items.map((item, position) => ({
        ...item,
        // Lists put the newest item first; one millisecond per position keeps that order for
        // undated items discovered in the same check.
        discoveredAt: new Date(date.getTime() - position).toISOString(),
        itemKey: fingerprint(item.identity),
      }))
      const seen = new Set(
        await this.repository.findWebListItemKeys(
          source.id,
          candidates.map((item) => item.itemKey),
        ),
      )
      const items: StoredWebListItem[] = []
      const deadline = Date.now() + WEB_LIST_DETAIL_BUDGET_MS
      const lastRequests = new Map<string, number>()
      let deferred = !fetched.complete
      for (const item of candidates) {
        if (seen.has(item.itemKey)) continue
        seen.add(item.itemKey)
        if (
          source.detail.enabled &&
          Date.now() + this.fetcher.timeoutMs + this.fetcher.requestDelayMs > deadline
        ) {
          deferred = true
          break
        }
        let detail: Pick<WebListItem, "title" | "content" | "detailStatus"> = {
          title: item.title,
          content: null,
          detailStatus: "skipped",
        }
        if (source.detail.enabled) {
          await this.fetcher.waitForOrigin(item.url, lastRequests)
          detail = await this.fetcher.detail(item, source)
          lastRequests.set(new URL(item.url).origin, Date.now())
        }
        items.push({
          id: randomUUID(),
          sourceId: source.id,
          itemKey: item.itemKey,
          guid: `urn:folo:web-list:${source.id}:${item.itemKey.slice(0, 32)}`,
          url: item.url,
          summary: item.summary,
          publishedAt: item.publishedAt,
          discoveredAt: item.discoveredAt,
          ...detail,
        })
      }
      const saved = await this.repository.saveWebListObservation(
        {
          ...source,
          etag: deferred ? null : fetched.etag,
          lastModified: deferred ? null : fetched.lastModified,
          consecutiveFailures: 0,
          lastAttemptAt: now,
          lastSuccessAt: now,
          lastErrorCode: null,
          lastErrorSummary: null,
          updatedAt: now,
          nextCheckAt: nextCheck(source, now),
        },
        items,
      )
      return {
        source: publicSource(saved),
        status: items.length ? ("items_published" as const) : ("unchanged" as const),
        publishedCount: items.length,
      }
    } catch (error) {
      const failure = publicError(error)
      const delay = Math.min(
        15 * 60000 * 2 ** source.consecutiveFailures,
        Math.max((source.intervalMinutes ?? 360) * 60000, 6 * 60 * 60000),
        24 * 60 * 60000,
      )
      await this.repository.saveWebListObservation(
        {
          ...source,
          consecutiveFailures: source.consecutiveFailures + 1,
          lastAttemptAt: now,
          lastErrorCode: failure.code,
          lastErrorSummary: failure.message.slice(0, 500),
          updatedAt: now,
          nextCheckAt: nextCheck(source, now, delay),
        },
        [],
      )
      throw failure
    }
  }
  async runDueCycle(now = new Date(), limit = 25): Promise<{ checked: number; failed: number }> {
    const sources = await this.repository.listDueWebListSources(now.toISOString(), limit)
    let failed = 0
    for (const source of sources) {
      try {
        await this.checkSource(source.id, now)
      } catch {
        failed++
      }
    }
    return { checked: sources.length, failed }
  }
  async materializeFeed(input: string) {
    const parsed = parseWebListSource(input)
    const source = await this.repository.findWebListSource(parsed.sourceId)
    if (!source)
      throw new WebListError("web_list_source_not_found", "Web list source was not found", 404)
    const items = await this.repository.listWebListItems(source.id, 100)
    const etag = `"web-list-${fingerprint(`${source.id}:${source.name}:${source.targetURL}:${items[0]?.guid ?? "empty"}:${items.length}`).slice(0, 24)}"`
    const rendered = items
      .map((item) => {
        const excerpt =
          item.summary ??
          (item.content
            ? (
                parseHTML(`<html><body>${item.content}</body></html>`).document.body.textContent ??
                ""
              )
                .replace(/\s+/g, " ")
                .trim()
            : "")
        return `<item><guid isPermaLink="false">${escapeXML(item.guid)}</guid><title>${escapeXML(item.title)}</title><link>${escapeXML(item.url)}</link><pubDate>${new Date(item.publishedAt ?? item.discoveredAt).toUTCString()}</pubDate><description>${escapeXML(boundedUTF8(excerpt, 4096))}</description><content:encoded>${escapeXML(item.content ?? "")}</content:encoded><category>web-list</category></item>`
      })
      .join("\n")
    return {
      source: publicSource(source),
      etag,
      body: `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${escapeXML(source.name)}</title><link>${escapeXML(source.targetURL)}</link><description>${escapeXML(source.name)}</description><lastBuildDate>${new Date(source.updatedAt).toUTCString()}</lastBuildDate>${rendered}</channel></rss>`,
    }
  }
}

export const startWebListScheduler = ({
  service,
  pollIntervalMs,
  onCycle,
}: {
  service: WebListService
  pollIntervalMs: number
  onCycle?: (result: { checked: number; failed: number }) => void
}) => {
  let activeRun: Promise<void> | null = null
  const run = () => {
    if (activeRun) return
    activeRun = service
      .runDueCycle()
      .then(onCycle)
      .catch(() => onCycle?.({ checked: 0, failed: 1 }))
      .finally(() => {
        activeRun = null
      })
  }
  const timer = setInterval(run, pollIntervalMs)
  timer.unref()
  run()
  return async () => {
    clearInterval(timer)
    await activeRun
  }
}
