export const RSSHUB_SELF_HOSTED_CAPABILITY = "sources.rsshub_self_hosted" as const

export type AutonomousSourceProviderId = "rsshub"
export type AutonomousSourceProviderStatus = "disabled" | "ready" | "unavailable"
export type SourceRegistryMode = "managed_only" | "permissive"

export interface AutonomousSourceProviderHealth {
  configured: boolean
  id: AutonomousSourceProviderId
  managedRouteCount?: number
  message: string | null
  persistenceStatus?: "ready" | "unavailable"
  registryMode?: SourceRegistryMode
  status: AutonomousSourceProviderStatus
}

export interface SourceCredentialSummary {
  createdAt: string
  description: string | null
  disabledAt: string | null
  id: string
  keyId: string
  name: string
  updatedAt: string
}

export interface SourceRouteInstance {
  createdAt: string
  deletedAt: string | null
  enabled: boolean
  id: string
  name: string
  secretQueryBindings: Record<string, string>
  sourceURL: string
  updatedAt: string
}

export type SourceAuditAction =
  | "credential.created"
  | "credential.disabled"
  | "credential.rotated"
  | "credential.updated"
  | "route.created"
  | "route.deleted"
  | "route.tested"
  | "route.updated"

export interface SourceAuditEvent {
  action: SourceAuditAction
  actor: string
  details: Record<string, boolean | number | string | null>
  eventHash: string
  id: string
  occurredAt: string
  previousHash: string | null
  resourceId: string | null
  resourceType: "credential" | "route" | "system"
  sequence: number
}

export interface SourceAuditVerification {
  brokenAtSequence: number | null
  checkedEvents: number
  valid: boolean
}

export interface RssHubSource {
  logicalURL: string
  routePath: string
  search: string
}

const maximumSourceURLLength = 2_048

export const parseRssHubSource = (input: string): RssHubSource => {
  if (input.length > maximumSourceURLLength) {
    throw new Error(`RSSHub source URL must not exceed ${maximumSourceURLLength} characters`)
  }

  let sourceURL: URL
  try {
    sourceURL = new URL(input)
  } catch {
    throw new Error("RSSHub source URL is invalid")
  }

  if (sourceURL.protocol !== "rsshub:") {
    throw new Error("RSSHub source URL must use the rsshub:// scheme")
  }
  if (!sourceURL.hostname) throw new Error("RSSHub source URL must include a route namespace")
  if (sourceURL.username || sourceURL.password || sourceURL.port) {
    throw new Error("RSSHub source URL must not contain credentials or a port")
  }
  if (sourceURL.hash) throw new Error("RSSHub source URL must not contain a fragment")
  if ([...sourceURL.searchParams.keys()].some((key) => key.toLowerCase() === "key")) {
    throw new Error("RSSHub access keys must be configured by the source supplier")
  }
  if (sourceURL.pathname.includes("\0")) throw new Error("RSSHub source route is invalid")

  return {
    logicalURL: sourceURL.toString(),
    routePath: `/${sourceURL.hostname}${sourceURL.pathname}`,
    search: sourceURL.search,
  }
}
