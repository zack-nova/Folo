import type { AuditEventDraft } from "./audit"
import type { EncryptedCredentialValue } from "./credential-cipher"

export interface StoredPublicFeedGrant {
  id: string
  name: string
  createdAt: string
  revokedAt: string | null
}

export interface PublicFeedAccess {
  at: string
  ip: string | null
  userAgent: string | null
}

export interface StoredPublicFeedLink {
  id: string
  grantId: string
  sourceURL: string
  title: string | null
  category: string | null
  /** SHA-256 of the link token */
  tokenHash: Buffer
  /** The token, encrypted so that links can be exported again */
  token: EncryptedCredentialValue
  createdAt: string
  rotatedAt: string | null
  revokedAt: string | null
  lastAccess: PublicFeedAccess | null
}

export interface PublicFeedRepository {
  createPublicFeedGrant(
    grant: StoredPublicFeedGrant,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedGrant>
  findPublicFeedGrant(id: string): Promise<StoredPublicFeedGrant | null>
  listPublicFeedGrants(): Promise<StoredPublicFeedGrant[]>
  /** Revokes the grant together with every link it still holds. */
  revokePublicFeedGrant(
    id: string,
    revokedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedGrant | null>
  /** Null when the grant is not active; checked atomically with the insert. */
  createPublicFeedLink(
    link: StoredPublicFeedLink,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null>
  findPublicFeedLink(id: string): Promise<StoredPublicFeedLink | null>
  listPublicFeedLinks(grantId: string): Promise<StoredPublicFeedLink[]>
  /** Replaces the token of an active link. */
  rotatePublicFeedLink(
    id: string,
    replacement: Pick<StoredPublicFeedLink, "token" | "tokenHash">,
    rotatedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null>
  updatePublicFeedLinkMetadata(
    id: string,
    metadata: Pick<StoredPublicFeedLink, "category" | "title">,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null>
  /**
   * Stores tokens re-encrypted under the active key, in one transaction. A link whose token hash
   * changed since it was read (rotated meanwhile) is skipped; returns the links updated.
   */
  reencryptPublicFeedLinkTokens(
    updates: Array<Pick<StoredPublicFeedLink, "id" | "token" | "tokenHash">>,
    audit: AuditEventDraft,
  ): Promise<number>
  revokePublicFeedLink(
    id: string,
    revokedAt: string,
    audit: AuditEventDraft,
  ): Promise<StoredPublicFeedLink | null>
  /** The active link with this token hash, provided its grant is active too. */
  findActivePublicFeedLinkByTokenHash(tokenHash: Buffer): Promise<StoredPublicFeedLink | null>
  recordPublicFeedAccess(id: string, access: PublicFeedAccess): Promise<void>
  /** Whether any active grant still exposes this source through a link */
  hasActivePublicFeedLinkForSource(sourceURL: string): Promise<boolean>
}
