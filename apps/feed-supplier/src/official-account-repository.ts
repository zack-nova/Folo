import type { OfficialAccountStatus, OfficialAccountSummary } from "@follow/feed-source-contracts"

import type { AuditEventDraft } from "./audit"
import type { EncryptedCredentialValue } from "./credential-cipher"

/** The linked official Folo account (ADR-0034) together with its encrypted session token. */
export interface StoredOfficialAccount extends Omit<OfficialAccountSummary, "status"> {
  status: OfficialAccountStatus
  token: EncryptedCredentialValue
  unlinkedAt: string | null
}

/** Fields refreshed after the official API accepted the session again. */
export type OfficialAccountVerification = Pick<
  StoredOfficialAccount,
  | "feedSubscriptionLimit"
  | "lastVerifiedAt"
  | "role"
  | "rssHubSubscriptionLimit"
  | "sessionExpiresAt"
>

export interface OfficialAccountRepository {
  /** The account that is not unlinked, if any; at most one exists. */
  findLinkedOfficialAccount(): Promise<StoredOfficialAccount | null>
  /**
   * Links a new account, unlinking the previous one in the same transaction so that relinking
   * with a fresh session never leaves a gap or two linked accounts.
   */
  linkOfficialAccount(
    account: StoredOfficialAccount,
    audit: AuditEventDraft,
  ): Promise<StoredOfficialAccount>
  recordOfficialAccountVerification(
    id: string,
    verification: OfficialAccountVerification,
    audit: AuditEventDraft,
  ): Promise<StoredOfficialAccount | null>
  /** Null when the account is not active, so the transition is recorded only once. */
  markOfficialAccountAuthInvalid(
    id: string,
    at: string,
    audit: AuditEventDraft,
  ): Promise<StoredOfficialAccount | null>
  unlinkOfficialAccount(
    id: string,
    at: string,
    audit: AuditEventDraft,
  ): Promise<StoredOfficialAccount | null>
  /** Stores the token re-encrypted under the active key; false when the account changed. */
  reencryptOfficialAccountToken(
    id: string,
    token: EncryptedCredentialValue,
    audit: AuditEventDraft,
  ): Promise<boolean>
}
