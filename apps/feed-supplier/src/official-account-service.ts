import { randomUUID } from "node:crypto"

import type {
  AutonomousSourceProviderHealth,
  OfficialAccountSummary,
} from "@follow/feed-source-contracts"

import { createAuditDraft } from "./audit"
import type { CredentialCipher } from "./credential-cipher"
import type { FoloOfficialClient } from "./folo-official-client"
import { isOfficialSessionToken, OfficialAPIError } from "./folo-official-client"
import type {
  OfficialAccountRepository,
  StoredOfficialAccount,
} from "./official-account-repository"

export class OfficialAccountError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
  }
}

// The session shares the credential cipher; the distinct id keeps its ciphertext from being
// accepted as a credential or a public link token.
const cipherId = (accountId: string) => `official-account:${accountId}`

const summary = (account: StoredOfficialAccount): OfficialAccountSummary => {
  if (account.status === "unlinked") throw new Error("An unlinked account has no summary")
  return {
    authInvalidAt: account.authInvalidAt,
    externalUserId: account.externalUserId,
    feedSubscriptionLimit: account.feedSubscriptionLimit,
    id: account.id,
    lastVerifiedAt: account.lastVerifiedAt,
    linkedAt: account.linkedAt,
    role: account.role,
    rssHubSubscriptionLimit: account.rssHubSubscriptionLimit,
    sessionExpiresAt: account.sessionExpiresAt,
    status: account.status,
  }
}

const unavailable = (error: unknown) =>
  new OfficialAccountError(
    "official_unavailable",
    error instanceof Error ? error.message.slice(0, 300) : "The official API is unavailable",
    502,
  )

/**
 * Re-encrypts the linked account's session if it is still under an older key, so the key can be
 * retired (ADR-0026). Returns the number of sessions re-encrypted.
 */
export const reencryptOfficialAccountToken = async (
  repository: OfficialAccountRepository,
  cipher: CredentialCipher,
  actor: string,
): Promise<number> => {
  const account = await repository.findLinkedOfficialAccount()
  if (!account || account.token.keyId === cipher.activeId) return 0
  const token = cipher.encrypt(
    cipherId(account.id),
    cipher.decrypt(cipherId(account.id), account.token),
  )
  const updated = await repository.reencryptOfficialAccountToken(
    account.id,
    token,
    createAuditDraft(actor, "official_account.reencrypted", "official_account", account.id, {
      activeKeyId: cipher.activeId,
    }),
  )
  return updated ? 1 : 0
}

/** The official Folo account the supplier uses for official acquisition (ADR-0034). */
export class OfficialAccountService {
  constructor(
    private readonly repository: OfficialAccountRepository,
    private readonly cipher: CredentialCipher,
    private readonly client: FoloOfficialClient,
  ) {}

  async getAccount(): Promise<OfficialAccountSummary | null> {
    const account = await this.repository.findLinkedOfficialAccount()
    return account ? summary(account) : null
  }

  /** Validates the session with the official API, then replaces any linked account. */
  async link(token: string, actor: string): Promise<OfficialAccountSummary> {
    const trimmed = token.trim()
    if (!isOfficialSessionToken(trimmed)) {
      throw new OfficialAccountError(
        "invalid_token",
        "The official session token is malformed",
        400,
      )
    }
    let session
    try {
      session = await this.client.getSession(trimmed)
    } catch (error) {
      if (error instanceof OfficialAPIError && error.kind === "auth_invalid") {
        throw new OfficialAccountError(
          "official_session_rejected",
          "The official API rejected this session; sign in again and use the new token",
          400,
        )
      }
      throw unavailable(error)
    }
    const now = new Date().toISOString()
    const id = randomUUID()
    const previous = await this.repository.findLinkedOfficialAccount()
    const account = await this.repository.linkOfficialAccount(
      {
        authInvalidAt: null,
        externalUserId: session.externalUserId,
        feedSubscriptionLimit: session.feedSubscriptionLimit,
        id,
        lastVerifiedAt: now,
        linkedAt: now,
        role: session.role,
        rssHubSubscriptionLimit: session.rssHubSubscriptionLimit,
        sessionExpiresAt: session.sessionExpiresAt,
        status: "active",
        token: this.cipher.encrypt(cipherId(id), trimmed),
        unlinkedAt: null,
      },
      createAuditDraft(actor, "official_account.linked", "official_account", id, {
        externalUserId: session.externalUserId,
        replacedAccountId: previous?.id ?? null,
        role: session.role,
      }),
    )
    return summary(account)
  }

  /**
   * Checks the session again and refreshes the plan and limits. A rejected session marks the
   * account `auth_invalid`; that is a result, not an error.
   */
  async verify(actor: string): Promise<OfficialAccountSummary> {
    const account = await this.requireAccount()
    if (account.status !== "active") {
      throw new OfficialAccountError(
        "official_account_auth_invalid",
        "The official session was rejected earlier; link the account again",
        409,
      )
    }
    let session
    try {
      session = await this.client.getSession(this.decryptToken(account))
    } catch (error) {
      if (error instanceof OfficialAPIError && error.kind === "auth_invalid") {
        return summary((await this.markAuthInvalid(account.id, actor)) ?? account)
      }
      throw unavailable(error)
    }
    const updated = await this.repository.recordOfficialAccountVerification(
      account.id,
      {
        feedSubscriptionLimit: session.feedSubscriptionLimit,
        lastVerifiedAt: new Date().toISOString(),
        role: session.role,
        rssHubSubscriptionLimit: session.rssHubSubscriptionLimit,
        sessionExpiresAt: session.sessionExpiresAt,
      },
      createAuditDraft(actor, "official_account.verified", "official_account", account.id, {
        role: session.role,
      }),
    )
    if (!updated)
      throw new OfficialAccountError("official_account_changed", "Retry the request", 409)
    return summary(updated)
  }

  async unlink(actor: string): Promise<void> {
    const account = await this.requireAccount()
    await this.repository.unlinkOfficialAccount(
      account.id,
      new Date().toISOString(),
      createAuditDraft(actor, "official_account.unlinked", "official_account", account.id, {}),
    )
  }

  /**
   * The session of the active account for official requests, or null. Callers report a rejected
   * session through `markAuthInvalid` so that no further requests are sent with it.
   */
  async activeSession(): Promise<{ accountId: string; token: string } | null> {
    const account = await this.repository.findLinkedOfficialAccount()
    if (!account || account.status !== "active") return null
    return { accountId: account.id, token: this.decryptToken(account) }
  }

  async markAuthInvalid(accountId: string, actor: string): Promise<StoredOfficialAccount | null> {
    return this.repository.markOfficialAccountAuthInvalid(
      accountId,
      new Date().toISOString(),
      createAuditDraft(actor, "official_account.auth_invalid", "official_account", accountId, {}),
    )
  }

  async providerHealth(): Promise<AutonomousSourceProviderHealth> {
    let account: StoredOfficialAccount | null
    try {
      account = await this.repository.findLinkedOfficialAccount()
    } catch {
      return {
        configured: true,
        id: "folo_official",
        message: "Source registry persistence is unavailable",
        persistenceStatus: "unavailable",
        status: "unavailable",
      }
    }
    const officialAccountStatus = account?.status ?? "unlinked"
    return {
      configured: true,
      id: "folo_official",
      message:
        officialAccountStatus === "active"
          ? null
          : officialAccountStatus === "auth_invalid"
            ? "The official session was rejected; link the account again"
            : "No official account is linked",
      officialAccountStatus,
      persistenceStatus: "ready",
      status: officialAccountStatus === "active" ? "ready" : "unavailable",
    }
  }

  private async requireAccount(): Promise<StoredOfficialAccount> {
    const account = await this.repository.findLinkedOfficialAccount()
    if (!account) {
      throw new OfficialAccountError(
        "official_account_not_linked",
        "No official account is linked",
        404,
      )
    }
    return account
  }

  private decryptToken(account: StoredOfficialAccount): string {
    return this.cipher.decrypt(cipherId(account.id), account.token)
  }
}
