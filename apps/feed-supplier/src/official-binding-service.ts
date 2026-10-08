import { randomUUID } from "node:crypto"

import type {
  OfficialAcquisitionBinding,
  OfficialSubscriptionSummary,
  SourceCredentialDependency,
} from "@follow/feed-source-contracts"
import { parseRssHubSource } from "@follow/feed-source-contracts"
import { z } from "zod"

import { createAuditDraft } from "./audit"
import type { FoloOfficialClient } from "./folo-official-client"
import { OfficialAPIError } from "./folo-official-client"
import type { OfficialFeedDocument } from "./folo-official-feed"
import { fetchOfficialFeed } from "./folo-official-feed"
import type { OfficialAccountService } from "./official-account-service"
import { OfficialAccountError } from "./official-account-service"
import type { OfficialBindingRepository } from "./official-binding-repository"
import type { PublicFeedRepository } from "./public-feed-repository"
import { RepositoryConflictError } from "./repository"
import { secretQueryParameter } from "./secret-parameters"

/** The parts of an official subscription the supplier relies on; other fields are ignored. */
const officialSubscriptionSchema = z.object({
  category: z.string().max(256).nullable().optional(),
  feedId: z.string().min(1).max(64),
  feeds: z
    .object({ url: z.string().max(2_048) })
    .nullable()
    .optional(),
  isPrivate: z.boolean().optional(),
  title: z.string().max(512).nullable().optional(),
})
const officialSubscriptionList = z.object({ data: z.array(z.unknown()) })

export type CredentialDependencyResolver = (
  sourceURL: string,
) => Promise<SourceCredentialDependency>

/**
 * Bindings that serve a source through the owner's official account (ADR-0034). This slice only
 * adopts subscriptions the account already has; the supplier never subscribes or unsubscribes
 * on the owner's behalf, so unbinding leaves the official account untouched.
 */
export class OfficialBindingService {
  constructor(
    private readonly repository: OfficialBindingRepository & PublicFeedRepository,
    private readonly accounts: OfficialAccountService,
    private readonly client: FoloOfficialClient,
    private readonly resolveDependency: CredentialDependencyResolver,
  ) {}

  /** The account's `rsshub://` subscriptions, normalized to logical addresses. */
  async listOfficialSubscriptions(actor: string): Promise<OfficialSubscriptionSummary[]> {
    const session = await this.requireSession()
    const payload = await this.officialCall(session, actor, () =>
      this.client.request("subscriptions.list", session.token),
    )
    const parsed = officialSubscriptionList.safeParse(payload)
    if (!parsed.success) {
      throw new OfficialAccountError(
        "official_unavailable",
        "The official subscription list is invalid",
        502,
      )
    }
    const bound = new Set((await this.repository.listOfficialBindings()).map((b) => b.sourceURL))
    const subscriptions: OfficialSubscriptionSummary[] = []
    for (const item of parsed.data.data) {
      const subscription = officialSubscriptionSchema.safeParse(item)
      const url = subscription.success ? subscription.data.feeds?.url : undefined
      if (!subscription.success || !url?.startsWith("rsshub://")) continue
      let sourceURL: string
      try {
        sourceURL = parseRssHubSource(url).logicalURL
      } catch {
        continue
      }
      subscriptions.push({
        bound: bound.has(sourceURL),
        category: subscription.data.category ?? null,
        externalFeedId: subscription.data.feedId,
        isPrivate: subscription.data.isPrivate ?? false,
        sourceURL,
        title: subscription.data.title ?? null,
      })
    }
    return subscriptions.sort((left, right) => left.sourceURL.localeCompare(right.sourceURL))
  }

  async listBindings(): Promise<OfficialAcquisitionBinding[]> {
    return this.repository.listOfficialBindings()
  }

  async getBinding(id: string): Promise<OfficialAcquisitionBinding | null> {
    const binding = await this.repository.findOfficialBinding(id)
    return binding && binding.status !== "deleted" ? binding : null
  }

  /** The active binding for a logical address, used by the read path. */
  async activeBindingFor(sourceURL: string): Promise<OfficialAcquisitionBinding | null> {
    const binding = await this.repository.findLiveOfficialBindingBySourceURL(sourceURL)
    return binding?.status === "active" ? binding : null
  }

  /** Whether a live binding exists; public links are refused for such sources. */
  async hasLiveBinding(sourceURL: string): Promise<boolean> {
    return (await this.repository.findLiveOfficialBindingBySourceURL(sourceURL)) !== null
  }

  /** Creates a binding and tries to adopt the matching official subscription right away. */
  async bind(input: string, actor: string): Promise<OfficialAcquisitionBinding> {
    const sourceURL = await this.validateSource(input)
    const session = await this.requireSession()
    let binding: OfficialAcquisitionBinding
    try {
      binding = await this.repository.createOfficialBinding(
        {
          accountId: session.accountId,
          activatedAt: null,
          consecutiveFailureCount: 0,
          createdAt: new Date().toISOString(),
          deletedAt: null,
          externalFeedId: null,
          id: randomUUID(),
          lastErrorCode: null,
          lastErrorSummary: null,
          lastSuccessAt: null,
          origin: null,
          sourceURL,
          status: "pending",
        },
        createAuditDraft(actor, "official_binding.created", "official_binding", null, {
          sourceURL,
        }),
      )
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        throw new OfficialAccountError("official_binding_exists", error.message, 409)
      }
      throw error
    }
    return this.adopt(binding, actor)
  }

  async retry(id: string, actor: string): Promise<OfficialAcquisitionBinding> {
    const binding = await this.getBinding(id)
    if (!binding) {
      throw new OfficialAccountError("official_binding_not_found", "Binding was not found", 404)
    }
    if (binding.status === "active") return binding
    return this.adopt(binding, actor)
  }

  async unbind(id: string, actor: string): Promise<void> {
    const deleted = await this.repository.deleteOfficialBinding(
      id,
      new Date().toISOString(),
      createAuditDraft(actor, "official_binding.deleted", "official_binding", id, {}),
    )
    if (!deleted) {
      throw new OfficialAccountError("official_binding_not_found", "Binding was not found", 404)
    }
  }

  /**
   * The newest entries of a bound source, rendered as RSS. Read failures are recorded on the
   * binding; a rejected session also disables the account.
   */
  async readFeed(
    binding: OfficialAcquisitionBinding,
    limit: number,
    actor = "feed-supplier-read",
  ): Promise<OfficialFeedDocument> {
    const session = await this.requireSession()
    if (!binding.externalFeedId) {
      throw new OfficialAccountError(
        "official_binding_inactive",
        "The binding has no official feed id",
        503,
      )
    }
    try {
      const document = await this.officialCall(session, actor, () =>
        fetchOfficialFeed(
          this.client,
          session.token,
          binding.externalFeedId!,
          binding.sourceURL,
          limit,
        ),
      )
      await this.recordRead(binding.id, null)
      return document
    } catch (error) {
      if (error instanceof OfficialAccountError) {
        await this.recordRead(binding.id, { code: error.code, summary: error.message })
      }
      throw error
    }
  }

  /** Records the outcome of a read through the binding, for diagnostics. */
  async recordRead(id: string, outcome: { code: string; summary: string } | null): Promise<void> {
    const binding = await this.repository.findOfficialBinding(id)
    if (!binding || binding.status !== "active") return
    await this.repository.updateOfficialBinding(
      id,
      outcome
        ? {
            consecutiveFailureCount: binding.consecutiveFailureCount + 1,
            lastErrorCode: outcome.code,
            lastErrorSummary: outcome.summary.slice(0, 500),
          }
        : {
            consecutiveFailureCount: 0,
            lastErrorCode: null,
            lastErrorSummary: null,
            lastSuccessAt: new Date().toISOString(),
          },
      null,
    )
  }

  private async adopt(
    binding: OfficialAcquisitionBinding,
    actor: string,
  ): Promise<OfficialAcquisitionBinding> {
    const fail = async (code: string, summary: string) =>
      (await this.repository.updateOfficialBinding(
        binding.id,
        {
          consecutiveFailureCount: binding.consecutiveFailureCount + 1,
          lastErrorCode: code,
          lastErrorSummary: summary.slice(0, 500),
          status: "failed",
        },
        createAuditDraft(actor, "official_binding.failed", "official_binding", binding.id, {
          code,
          sourceURL: binding.sourceURL,
        }),
      )) ?? binding

    let subscriptions: OfficialSubscriptionSummary[]
    try {
      subscriptions = await this.listOfficialSubscriptions(actor)
    } catch (error) {
      if (error instanceof OfficialAccountError) return fail(error.code, error.message)
      throw error
    }
    const match = subscriptions.find((item) => item.sourceURL === binding.sourceURL)
    if (!match) {
      return fail(
        "official_not_subscribed",
        "The official account is not subscribed to this source; subscribe there first",
      )
    }
    const now = new Date().toISOString()
    return (
      (await this.repository.updateOfficialBinding(
        binding.id,
        {
          activatedAt: now,
          consecutiveFailureCount: 0,
          externalFeedId: match.externalFeedId,
          lastErrorCode: null,
          lastErrorSummary: null,
          origin: "adopted",
          status: "active",
        },
        createAuditDraft(actor, "official_binding.activated", "official_binding", binding.id, {
          externalFeedId: match.externalFeedId,
          origin: "adopted",
          sourceURL: binding.sourceURL,
        }),
      )) ?? binding
    )
  }

  private async validateSource(input: string): Promise<string> {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      throw new OfficialAccountError("invalid_source", "Source address is invalid", 400)
    }
    if (url.protocol !== "rsshub:") {
      throw new OfficialAccountError(
        "invalid_source",
        "Only rsshub:// sources can be fetched through the official account",
        400,
      )
    }
    // A secret in the address would be sent to the official API.
    const secret = secretQueryParameter(url)
    if (secret) {
      throw new OfficialAccountError(
        "invalid_source",
        `The address carries the secret query parameter ${secret}`,
        400,
      )
    }
    let sourceURL: string
    try {
      sourceURL = parseRssHubSource(input).logicalURL
    } catch (error) {
      throw new OfficialAccountError(
        "invalid_source",
        error instanceof Error ? error.message : "Source address is invalid",
        400,
      )
    }
    const dependency = await this.resolveDependency(sourceURL)
    if (dependency.boundCredentials.length > 0) {
      throw new OfficialAccountError(
        "invalid_source",
        `The source is bound to supplier credentials (${dependency.boundCredentials.join(", ")}); they must not reach the official API`,
        409,
      )
    }
    if (await this.repository.hasActivePublicFeedLinkForSource(sourceURL)) {
      throw new OfficialAccountError(
        "source_has_public_link",
        "The source is published through a public link; revoke the link first",
        409,
      )
    }
    return sourceURL
  }

  private async requireSession() {
    const session = await this.accounts.activeSession()
    if (!session) {
      throw new OfficialAccountError(
        "official_account_not_linked",
        "No active official account is linked",
        409,
      )
    }
    return session
  }

  /** Runs an official call, turning a rejected session into `auth_invalid` on the account. */
  private async officialCall<T>(
    session: { accountId: string; token: string },
    actor: string,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (error instanceof OfficialAPIError) {
        if (error.kind === "auth_invalid") {
          await this.accounts.markAuthInvalid(session.accountId, actor)
          throw new OfficialAccountError(
            "official_auth_invalid",
            "The official session was rejected; link the account again",
            409,
          )
        }
        if (error.kind === "rate_limited") {
          throw new OfficialAccountError("official_rate_limited", error.message, 429)
        }
        throw new OfficialAccountError("official_unavailable", error.message, 502)
      }
      throw error
    }
  }
}
