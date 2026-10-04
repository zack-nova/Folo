import { createHash, randomBytes, randomUUID } from "node:crypto"

import type {
  IssuedPublicFeedLink,
  PublicFeedGrant,
  PublicFeedLink,
} from "@follow/feed-source-contracts"

import { createAuditDraft } from "./audit"
import type { CredentialCipher } from "./credential-cipher"
import type {
  PublicFeedAccess,
  PublicFeedRepository,
  StoredPublicFeedLink,
} from "./public-feed-repository"

/** 256-bit tokens, base64url without padding. */
const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[\w-]{43}$/
/** Polls are frequent; one access write per link and interval is enough to spot leaks. */
const ACCESS_RECORD_INTERVAL_MS = 60_000
const MAX_GRANT_NAME_LENGTH = 128

export class PublicFeedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
  }
}

export type PublicFeedSourceValidator = (sourceURL: string) => Promise<void>

const hashToken = (token: string) => createHash("sha256").update(token).digest()

// Link tokens share the credential cipher; the distinct id keeps their ciphertexts from being
// accepted as credentials or for another link.
const cipherId = (linkId: string) => `public-feed-link:${linkId}`

export const isPublicFeedToken = (value: string) => TOKEN_PATTERN.test(value)

export class PublicFeedService {
  private readonly lastAccessWrites = new Map<string, number>()

  constructor(
    private readonly repository: PublicFeedRepository,
    private readonly cipher: CredentialCipher,
    /** Public base of the subscription links, e.g. https://feeds.example.com */
    private readonly baseURL: string,
    private readonly validateSource: PublicFeedSourceValidator,
  ) {}

  async createGrant(name: string, actor: string): Promise<PublicFeedGrant> {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > MAX_GRANT_NAME_LENGTH) {
      throw new PublicFeedError(
        "invalid_grant",
        `Grant name must be 1-${MAX_GRANT_NAME_LENGTH} characters`,
        400,
      )
    }
    const grant = {
      id: randomUUID(),
      name: trimmed,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    }
    await this.repository.createPublicFeedGrant(
      grant,
      createAuditDraft(actor, "public_feed_grant.created", "public_feed_grant", grant.id, {
        name: trimmed,
      }),
    )
    return {
      ...grant,
      activeLinkCount: 0,
      lastAccessAt: null,
      lastAccessIP: null,
      lastAccessUserAgent: null,
    }
  }

  async listGrants(): Promise<PublicFeedGrant[]> {
    const grants = await this.repository.listPublicFeedGrants()
    return Promise.all(
      grants.map(async (grant) => {
        const links = await this.repository.listPublicFeedLinks(grant.id)
        const lastAccess = links
          .map((link) => link.lastAccess)
          .filter((access): access is PublicFeedAccess => access !== null)
          .sort((left, right) => right.at.localeCompare(left.at))[0]
        return {
          ...grant,
          activeLinkCount: links.filter((link) => !link.revokedAt).length,
          lastAccessAt: lastAccess?.at ?? null,
          lastAccessIP: lastAccess?.ip ?? null,
          lastAccessUserAgent: lastAccess?.userAgent ?? null,
        }
      }),
    )
  }

  async revokeGrant(grantId: string, actor: string): Promise<void> {
    const revoked = await this.repository.revokePublicFeedGrant(
      grantId,
      new Date().toISOString(),
      createAuditDraft(actor, "public_feed_grant.revoked", "public_feed_grant", grantId, {}),
    )
    if (!revoked) throw new PublicFeedError("grant_not_found", "Active grant not found", 404)
  }

  async issueLink(
    grantId: string,
    sourceURL: string,
    actor: string,
  ): Promise<IssuedPublicFeedLink> {
    const grant = await this.repository.findPublicFeedGrant(grantId)
    if (!grant || grant.revokedAt) {
      throw new PublicFeedError("grant_not_found", "Active grant not found", 404)
    }
    await this.validateSource(sourceURL)
    const id = randomUUID()
    const { token, stored } = this.newToken(id)
    const link: StoredPublicFeedLink = {
      id,
      grantId,
      sourceURL,
      ...stored,
      createdAt: new Date().toISOString(),
      rotatedAt: null,
      revokedAt: null,
      lastAccess: null,
    }
    const created = await this.repository.createPublicFeedLink(
      link,
      createAuditDraft(actor, "public_feed_link.created", "public_feed_link", id, {
        grantId,
        sourceURL,
      }),
    )
    // The grant was revoked while the source was being checked.
    if (!created) throw new PublicFeedError("grant_not_found", "Active grant not found", 404)
    return { ...linkSummary(link), url: this.linkURL(token) }
  }

  async listLinks(grantId: string): Promise<PublicFeedLink[]> {
    await this.requireGrant(grantId)
    return (await this.repository.listPublicFeedLinks(grantId)).map(linkSummary)
  }

  /** The grant's active links with their subscription URLs, for OPML or reader import. */
  async exportLinks(grantId: string): Promise<IssuedPublicFeedLink[]> {
    const grant = await this.requireGrant(grantId)
    if (grant.revokedAt) return []
    return (await this.repository.listPublicFeedLinks(grantId))
      .filter((link) => !link.revokedAt)
      .map((link) => ({
        ...linkSummary(link),
        url: this.linkURL(this.cipher.decrypt(cipherId(link.id), link.token)),
      }))
  }

  async rotateLink(grantId: string, linkId: string, actor: string): Promise<IssuedPublicFeedLink> {
    await this.requireLink(grantId, linkId)
    const { token, stored } = this.newToken(linkId)
    const rotated = await this.repository.rotatePublicFeedLink(
      linkId,
      stored,
      new Date().toISOString(),
      createAuditDraft(actor, "public_feed_link.rotated", "public_feed_link", linkId, { grantId }),
    )
    if (!rotated) throw new PublicFeedError("link_not_found", "Active link not found", 404)
    return { ...linkSummary(rotated), url: this.linkURL(token) }
  }

  async revokeLink(grantId: string, linkId: string, actor: string): Promise<void> {
    await this.requireLink(grantId, linkId)
    const revoked = await this.repository.revokePublicFeedLink(
      linkId,
      new Date().toISOString(),
      createAuditDraft(actor, "public_feed_link.revoked", "public_feed_link", linkId, { grantId }),
    )
    if (!revoked) throw new PublicFeedError("link_not_found", "Active link not found", 404)
  }

  /** The active link a token opens, or null for any token that must not be served. */
  async resolve(token: string): Promise<StoredPublicFeedLink | null> {
    if (!isPublicFeedToken(token)) return null
    return this.repository.findActivePublicFeedLinkByTokenHash(hashToken(token))
  }

  async recordAccess(linkId: string, access: PublicFeedAccess): Promise<void> {
    const now = Date.parse(access.at)
    if (now - (this.lastAccessWrites.get(linkId) ?? 0) < ACCESS_RECORD_INTERVAL_MS) return
    this.lastAccessWrites.set(linkId, now)
    await this.repository.recordPublicFeedAccess(linkId, access)
  }

  private newToken(linkId: string) {
    const token = randomBytes(TOKEN_BYTES).toString("base64url")
    return {
      token,
      stored: { tokenHash: hashToken(token), token: this.cipher.encrypt(cipherId(linkId), token) },
    }
  }

  private linkURL(token: string) {
    return `${this.baseURL}/f/${token}`
  }

  private async requireGrant(grantId: string) {
    const grant = await this.repository.findPublicFeedGrant(grantId)
    if (!grant) throw new PublicFeedError("grant_not_found", "Grant not found", 404)
    return grant
  }

  private async requireLink(grantId: string, linkId: string) {
    const link = await this.repository.findPublicFeedLink(linkId)
    if (!link || link.grantId !== grantId || link.revokedAt) {
      throw new PublicFeedError("link_not_found", "Active link not found", 404)
    }
    return link
  }
}

const linkSummary = (link: StoredPublicFeedLink): PublicFeedLink => ({
  id: link.id,
  grantId: link.grantId,
  sourceURL: link.sourceURL,
  createdAt: link.createdAt,
  rotatedAt: link.rotatedAt,
  revokedAt: link.revokedAt,
  lastAccessAt: link.lastAccess?.at ?? null,
  lastAccessIP: link.lastAccess?.ip ?? null,
  lastAccessUserAgent: link.lastAccess?.userAgent ?? null,
})
