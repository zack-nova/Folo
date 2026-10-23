import { createHash, randomUUID } from "node:crypto"

import type {
  PlatformBehaviorCheckResult,
  PlatformBehaviorEntry,
  PlatformBehaviorPlatform,
  PlatformBehaviorSource,
  PlatformBehaviorTestResult,
} from "@follow/feed-source-contracts"
import { behaviorFeedURL, parseBehaviorSource } from "@follow/feed-source-contracts"

import { createAuditDraft } from "./audit"
import type { PlatformBehaviorAdapter } from "./platform-behavior-adapter"
import { PlatformBehaviorError } from "./platform-behavior-adapter"
import type { StoredBehaviorObject } from "./platform-behavior-repository"
import type {
  CreateBehaviorSourceInput,
  UpdateBehaviorSourceInput,
} from "./platform-behavior-validation"
import type { SupplierRepository } from "./repository"
import { boundedUTF8, escapeXML } from "./web-list-extraction"

export { PlatformBehaviorError } from "./platform-behavior-adapter"
// Due behavior sources are polled exactly like due web lists.
export { startWebListScheduler as startBehaviorScheduler } from "./web-list-service"

const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex")
/** One check stops starting platform requests after this long. */
export const BEHAVIOR_CHECK_BUDGET_MS = 120_000
// Pages already read overlap the next check by this much, in case platform clocks drift.
const KNOWN_OVERLAP_MS = 60 * 60_000
const nextCheck = (
  source: PlatformBehaviorSource,
  now: string,
  delay = (source.intervalMinutes ?? 0) * 60_000,
) =>
  source.enabled && source.intervalMinutes ? new Date(Date.parse(now) + delay).toISOString() : null
const imageType = (url: string): string => {
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase()
  return extension === "png"
    ? "image/png"
    : extension === "webp"
      ? "image/webp"
      : extension === "gif"
        ? "image/gif"
        : "image/jpeg"
}
const notFound = () =>
  new PlatformBehaviorError("behavior_source_not_found", "Behavior source was not found", 404)
const publicError = (error: unknown): PlatformBehaviorError =>
  error instanceof PlatformBehaviorError
    ? error
    : new PlatformBehaviorError("behavior_check_failed", "Behavior check failed")

export interface PlatformBehaviorServiceOptions {
  adapters: PlatformBehaviorAdapter[]
  /** Decrypts a bound credential; throws when it is missing or disabled */
  resolveCredential: (credentialId: string) => Promise<string>
  checkBudgetMs?: number
}

/**
 * Behavior sources (ADR-0037): each check reads the current follows or favorites of one
 * account. The first check records a baseline; later checks publish objects that were never
 * seen and appeared after the baseline, so old objects that resurface stay quiet.
 */
export class PlatformBehaviorService {
  private readonly activeChecks = new Set<string>()
  private readonly adapters: Map<PlatformBehaviorPlatform, PlatformBehaviorAdapter>
  private readonly checkBudgetMs: number
  constructor(
    private readonly repository: SupplierRepository,
    private readonly options: PlatformBehaviorServiceOptions,
  ) {
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.platform, adapter]))
    this.checkBudgetMs = options.checkBudgetMs ?? BEHAVIOR_CHECK_BUDGET_MS
  }
  async listSources(): Promise<PlatformBehaviorSource[]> {
    return this.repository.listBehaviorSources()
  }
  async getSource(id: string): Promise<PlatformBehaviorSource | null> {
    return this.repository.findBehaviorSource(id)
  }
  async listEntries(id: string, limit: number): Promise<PlatformBehaviorEntry[] | null> {
    return (await this.repository.findBehaviorSource(id))
      ? this.repository.listBehaviorEntries(id, limit)
      : null
  }
  private adapterFor(platform: PlatformBehaviorPlatform): PlatformBehaviorAdapter {
    const adapter = this.adapters.get(platform)
    if (!adapter)
      throw new PlatformBehaviorError(
        "behavior_platform_unsupported",
        `Platform ${platform} is not supported`,
        400,
      )
    return adapter
  }
  private async assertCredential(credentialId: string | null): Promise<void> {
    if (!credentialId) return
    const credential = await this.repository.findCredential(credentialId)
    if (!credential || credential.disabledAt)
      throw new PlatformBehaviorError(
        "behavior_credential_unavailable",
        "The credential is missing or disabled",
        400,
      )
  }
  async createSource(
    input: CreateBehaviorSourceInput,
    actor: string,
  ): Promise<PlatformBehaviorSource> {
    const adapter = this.adapterFor(input.platform)
    if (!adapter.scopes.includes(input.scope))
      throw new PlatformBehaviorError(
        "behavior_scope_unsupported",
        `Scope ${input.scope} is not supported on ${input.platform}`,
        400,
      )
    if (!adapter.accountIdPattern.test(input.accountId))
      throw new PlatformBehaviorError(
        "behavior_account_invalid",
        `Account ID is not a valid ${input.platform} account`,
        400,
      )
    await this.assertCredential(input.credentialId)
    const now = new Date().toISOString()
    const id = randomUUID()
    const source: PlatformBehaviorSource = {
      ...input,
      id,
      feedURL: behaviorFeedURL(id),
      baselineAt: null,
      entryCount: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      consecutiveFailures: 0,
      nextCheckAt: input.enabled && input.intervalMinutes ? now : null,
    }
    return this.repository.createBehaviorSource(
      source,
      createAuditDraft(actor, "behavior_source.created", "behavior_source", id, {
        name: source.name,
        platform: source.platform,
        scope: source.scope,
        enabled: source.enabled,
        intervalMinutes: source.intervalMinutes,
        usesCredential: source.credentialId !== null,
      }),
    )
  }
  async updateSource(
    id: string,
    input: UpdateBehaviorSourceInput,
    actor: string,
  ): Promise<PlatformBehaviorSource | null> {
    this.assertIdle(id)
    const source = await this.repository.findBehaviorSource(id)
    if (!source) return null
    if (input.credentialId !== undefined) await this.assertCredential(input.credentialId)
    const updated: PlatformBehaviorSource = { ...source, ...input }
    const now = new Date().toISOString()
    // A new credential or schedule is tried right away, so a fixed login shows at once.
    const schedulingChanged =
      updated.enabled !== source.enabled ||
      updated.intervalMinutes !== source.intervalMinutes ||
      updated.credentialId !== source.credentialId
    updated.updatedAt = now
    updated.nextCheckAt =
      updated.enabled && updated.intervalMinutes
        ? schedulingChanged
          ? now
          : source.nextCheckAt
        : null
    return this.repository.updateBehaviorSource(
      updated,
      createAuditDraft(actor, "behavior_source.updated", "behavior_source", id, {
        name: updated.name,
        enabled: updated.enabled,
        intervalMinutes: updated.intervalMinutes,
        usesCredential: updated.credentialId !== null,
      }),
    )
  }
  async deleteSource(id: string, actor: string): Promise<boolean> {
    this.assertIdle(id)
    return Boolean(
      await this.repository.softDeleteBehaviorSource(
        id,
        new Date().toISOString(),
        createAuditDraft(actor, "behavior_source.deleted", "behavior_source", id, {}),
      ),
    )
  }
  private async read(source: PlatformBehaviorSource, knownUntil: string | null) {
    const credential = source.credentialId
      ? await this.options.resolveCredential(source.credentialId)
      : null
    return this.adapterFor(source.platform).read({
      accountId: source.accountId,
      scope: source.scope,
      credential,
      knownUntil,
      deadline: Date.now() + this.checkBudgetMs,
    })
  }
  /** Reads the platform without saving anything, to confirm the account and credential. */
  async testSource(id: string, actor: string): Promise<PlatformBehaviorTestResult | null> {
    this.assertIdle(id)
    const source = await this.repository.findBehaviorSource(id)
    if (!source) return null
    this.activeChecks.add(id)
    try {
      const result = await this.read(source, null)
      await this.repository.recordAudit(
        createAuditDraft(actor, "behavior_source.tested", "behavior_source", id, {
          succeeded: true,
          objectCount: result.objects.length,
          requestCount: result.requestCount,
        }),
      )
      return {
        notes: result.notes,
        objectCount: result.objects.length,
        objects: result.objects
          .slice(0, 10)
          .map(({ occurredAt, title, url }) => ({ occurredAt, title, url })),
        requestCount: result.requestCount,
      }
    } catch (error) {
      await this.repository.recordAudit(
        createAuditDraft(actor, "behavior_source.tested", "behavior_source", id, {
          succeeded: false,
          code: publicError(error).code,
        }),
      )
      throw publicError(error)
    } finally {
      this.activeChecks.delete(id)
    }
  }
  private assertIdle(id: string): void {
    if (this.activeChecks.has(id))
      throw new PlatformBehaviorError(
        "behavior_check_in_progress",
        "Behavior source is already being checked",
        409,
      )
  }
  async checkSource(id: string, now = new Date()): Promise<PlatformBehaviorCheckResult | null> {
    this.assertIdle(id)
    this.activeChecks.add(id)
    try {
      const source = await this.repository.findBehaviorSource(id)
      return source ? await this.performCheck(source, now) : null
    } finally {
      this.activeChecks.delete(id)
    }
  }
  private async performCheck(
    source: PlatformBehaviorSource,
    date: Date,
  ): Promise<PlatformBehaviorCheckResult> {
    const now = date.toISOString()
    const baseline = source.baselineAt
    try {
      const knownUntil =
        baseline && source.lastSuccessAt
          ? new Date(Date.parse(source.lastSuccessAt) - KNOWN_OVERLAP_MS).toISOString()
          : null
      const read = await this.read(source, baseline ? knownUntil : null)
      const seen = new Set(
        await this.repository.findBehaviorObjectKeys(
          source.id,
          read.objects.map((object) => object.key),
        ),
      )
      const unseen = read.objects.filter((object) => !seen.has(object.key))
      const appeared = baseline
        ? unseen.filter((object) => (object.occurredAt ?? now) > baseline)
        : []
      const entryByObject = new Map<string, string>()
      const entries = (
        appeared.length ? this.adapterFor(source.platform).render(source, appeared) : []
      ).map((entry): PlatformBehaviorEntry => {
        const guid = `urn:folo:behavior:${source.id}:${fingerprint([...entry.objectKeys].sort().join("\n")).slice(0, 32)}`
        for (const key of entry.objectKeys) entryByObject.set(key, guid)
        return {
          id: randomUUID(),
          sourceId: source.id,
          guid,
          title: entry.title,
          url: entry.url,
          summary: boundedUTF8(entry.summary, 4096),
          content: boundedUTF8(entry.content, 128 * 1024),
          imageURL: entry.imageURL,
          occurredAt: entry.occurredAt,
          discoveredAt: now,
        }
      })
      const objects: StoredBehaviorObject[] = unseen.map((object) => ({
        sourceId: source.id,
        objectKey: object.key,
        occurredAt: object.occurredAt,
        firstSeenAt: now,
        snapshot: object.snapshot,
        entryGuid: entryByObject.get(object.key) ?? null,
      }))
      const saved = await this.repository.saveBehaviorObservation(
        {
          ...source,
          baselineAt: baseline ?? now,
          consecutiveFailures: 0,
          lastAttemptAt: now,
          lastSuccessAt: now,
          lastErrorCode: null,
          lastErrorSummary: null,
          updatedAt: now,
          nextCheckAt: nextCheck(source, now),
        },
        objects,
        entries,
      )
      return {
        source: saved,
        status: !baseline
          ? "baseline_recorded"
          : entries.length
            ? "entries_published"
            : "unchanged",
        newObjectCount: unseen.length,
        notes: read.notes,
        publishedCount: entries.length,
      }
    } catch (error) {
      const failure = publicError(error)
      // Rate limiting and login failures do not improve by asking again soon.
      const minimum = ["behavior_rate_limited", "behavior_auth_invalid"].includes(failure.code)
        ? 6 * 60 * 60_000
        : 0
      const delay = Math.min(
        Math.max(15 * 60_000 * 2 ** source.consecutiveFailures, minimum),
        Math.max((source.intervalMinutes ?? 360) * 60_000, 6 * 60 * 60_000),
        24 * 60 * 60_000,
      )
      await this.repository.saveBehaviorObservation(
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
        [],
      )
      throw failure
    }
  }
  async runDueCycle(now = new Date(), limit = 10): Promise<{ checked: number; failed: number }> {
    const sources = await this.repository.listDueBehaviorSources(now.toISOString(), limit)
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
    const parsed = parseBehaviorSource(input)
    const source = await this.repository.findBehaviorSource(parsed.sourceId)
    if (!source) throw notFound()
    const entries = await this.repository.listBehaviorEntries(source.id, 100)
    const etag = `"behavior-${fingerprint(`${source.id}:${source.name}:${entries[0]?.guid ?? "empty"}:${entries.length}`).slice(0, 24)}"`
    const rendered = entries
      .map(
        (entry) =>
          `<item><guid isPermaLink="false">${escapeXML(entry.guid)}</guid><title>${escapeXML(entry.title)}</title><link>${escapeXML(entry.url)}</link><pubDate>${new Date(entry.occurredAt).toUTCString()}</pubDate><description>${escapeXML(entry.summary)}</description><content:encoded>${escapeXML(entry.content)}</content:encoded>${entry.imageURL ? `<enclosure url="${escapeXML(entry.imageURL)}" type="${imageType(entry.imageURL)}" length="0"/>` : ""}<category>${escapeXML(`${source.platform}-${source.scope}`)}</category></item>`,
      )
      .join("\n")
    const link = this.adapterFor(source.platform).profileURL(source)
    return {
      source,
      etag,
      upstreamURL: link,
      body: `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${escapeXML(source.name)}</title><link>${escapeXML(link)}</link><description>${escapeXML(source.name)}</description><lastBuildDate>${new Date(source.updatedAt).toUTCString()}</lastBuildDate>${rendered}</channel></rss>`,
    }
  }
}
