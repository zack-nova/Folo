export const RSSHUB_SELF_HOSTED_CAPABILITY = "sources.rsshub_self_hosted" as const
export const PAGE_CHANGE_CAPABILITY = "sources.page_change" as const
export const SOURCE_ROUTE_CATALOG_CAPABILITY = "sources.route_catalog" as const

export type AutonomousSourceProviderId = "page_change" | "rsshub"
export type AutonomousSourceProviderStatus = "disabled" | "ready" | "unavailable"
export type SourceRegistryMode = "managed_only" | "permissive"

export interface AutonomousSourceProviderHealth {
  catalogRouteCount?: number
  configured: boolean
  dueSourceCount?: number
  enabledSourceCount?: number
  id: AutonomousSourceProviderId
  lastCycleAt?: string | null
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

export type SourceCatalogParameterType = "boolean" | "enum" | "integer" | "string"
export type SourceCatalogParameterValue = boolean | number | string

export interface SourceCatalogParameterOption {
  label: string
  value: string
}

export interface SourceCatalogParameter {
  defaultValue: SourceCatalogParameterValue | null
  description: string | null
  key: string
  label: string
  location: "path" | "query"
  maximum: number | null
  minimum: number | null
  options: SourceCatalogParameterOption[]
  required: boolean
  type: SourceCatalogParameterType
}

export interface SourceCatalogRoute {
  category: string
  createdAt: string
  description: string | null
  documentationURL: string | null
  enabled: boolean
  id: string
  key: string
  parameters: SourceCatalogParameter[]
  requiresCredentials: boolean
  routePathTemplate: string
  title: string
  updatedAt: string
}

export interface SourceCatalogRouteAdministration extends SourceCatalogRoute {
  deletedAt: string | null
  secretQueryBindings: Record<string, string>
}

export interface SourceCatalogRenderResult {
  logicalURL: string
}

export interface SourceCatalogTestResult extends SourceCatalogRenderResult {
  contentBytes: number
  contentType: string | null
  upstreamStatus: number
  upstreamURL: string
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
  | "catalog_route.created"
  | "catalog_route.deleted"
  | "catalog_route.tested"
  | "catalog_route.updated"
  | "page_source.created"
  | "page_source.deleted"
  | "page_source.tested"
  | "page_source.updated"

export interface SourceAuditEvent {
  action: SourceAuditAction
  actor: string
  details: Record<string, boolean | number | string | null>
  eventHash: string
  id: string
  occurredAt: string
  previousHash: string | null
  resourceId: string | null
  resourceType: "catalog_route" | "credential" | "page_source" | "route" | "system"
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

export interface PageChangeSource {
  baselineFingerprint: string | null
  baselineObservedAt: string | null
  confirmDelaySeconds: number
  consecutiveFailures: number
  contentSelector: string | null
  createdAt: string
  deletedAt: string | null
  enabled: boolean
  eventCount: number
  feedURL: string
  id: string
  ignoreSelectors: string[]
  intervalMinutes: number | null
  lastAttemptAt: string | null
  lastErrorCode: string | null
  lastErrorSummary: string | null
  lastSuccessAt: string | null
  name: string
  nextCheckAt: string | null
  pendingConfirmAfter: string | null
  pendingFingerprint: string | null
  targetURL: string
  updatedAt: string
}

export interface PageChangeEvent {
  afterFingerprint: string
  beforeFingerprint: string | null
  content: string
  diff: string | null
  guid: string
  id: string
  publishedAt: string
  sourceId: string
  title: string
}

export interface ParsedPageChangeSource {
  logicalURL: string
  sourceId: string
}

const maximumSourceURLLength = 2_048

export const pageChangeFeedURL = (sourceId: string): string => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceId)
  ) {
    throw new Error("Page change source ID must be a UUID")
  }
  return `pagechange://${sourceId.toLowerCase()}`
}

export const parsePageChangeSource = (input: string): ParsedPageChangeSource => {
  let sourceURL: URL
  try {
    sourceURL = new URL(input)
  } catch {
    throw new Error("Page change source URL is invalid")
  }
  if (sourceURL.protocol !== "pagechange:") {
    throw new Error("Page change source URL must use the pagechange:// scheme")
  }
  if (sourceURL.username || sourceURL.password || sourceURL.port || sourceURL.pathname !== "") {
    throw new Error("Page change source URL must contain only a source ID")
  }
  if (sourceURL.search || sourceURL.hash) {
    throw new Error("Page change source URL must not contain a query or fragment")
  }
  return {
    logicalURL: pageChangeFeedURL(sourceURL.hostname),
    sourceId: sourceURL.hostname.toLowerCase(),
  }
}

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
