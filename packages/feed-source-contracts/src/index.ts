export const RSSHUB_SELF_HOSTED_CAPABILITY = "sources.rsshub_self_hosted" as const
export const PAGE_CHANGE_CAPABILITY = "sources.page_change" as const
export const SOURCE_ROUTE_CATALOG_CAPABILITY = "sources.route_catalog" as const
export const WEB_LIST_CAPABILITY = "sources.web_list" as const
export const WEB_LIST_MANAGEMENT_CAPABILITY = "sources.web_list_management" as const

export type AutonomousSourceProviderId = "page_change" | "rsshub" | "web_list"
export type AutonomousSourceProviderStatus = "disabled" | "ready" | "unavailable"
export type SourceRegistryMode = "managed_only" | "permissive"

export interface AutonomousSourceProviderHealth {
  activeRequestCount?: number
  cacheHitCount?: number
  cacheMissCount?: number
  cacheStatus?: "ready" | "unavailable"
  catalogRouteCount?: number
  coalescedRequestCount?: number
  configured: boolean
  concurrencyRejectedRequestCount?: number
  dueSourceCount?: number
  enabledSourceCount?: number
  id: AutonomousSourceProviderId
  lastCycleAt?: string | null
  managedRouteCount?: number
  message: string | null
  persistenceStatus?: "ready" | "unavailable"
  registryMode?: SourceRegistryMode
  rateLimitedRequestCount?: number
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

/** An RSSHub deployment credential (an environment variable of the RSSHub container). */
export interface RssHubCredentialRequirement {
  /** Environment variable name, e.g. TWITTER_AUTH_TOKEN */
  name: string
  /** False when the route works without it and only gains from it */
  required: boolean
}

export interface SourceCatalogRouteAdministration extends SourceCatalogRoute {
  deletedAt: string | null
  /**
   * RSSHub deployment credentials the route uses (ADR-0033). Null while undeclared, which the
   * credential overview reports as unknown rather than as none.
   */
  rssHubCredentials: RssHubCredentialRequirement[] | null
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
  | "web_list_source.created"
  | "web_list_source.deleted"
  | "web_list_source.tested"
  | "web_list_source.updated"
  | "public_feed_grant.created"
  | "public_feed_grant.revoked"
  | "public_feed_link.created"
  | "public_feed_link.revoked"
  | "public_feed_link.rotated"

export interface SourceAuditEvent {
  action: SourceAuditAction
  actor: string
  details: Record<string, boolean | number | string | null>
  eventHash: string
  id: string
  occurredAt: string
  previousHash: string | null
  resourceId: string | null
  resourceType:
    | "catalog_route"
    | "credential"
    | "page_source"
    | "public_feed_grant"
    | "public_feed_link"
    | "route"
    | "system"
    | "web_list_source"
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

export type WebListFormat = "html" | "json"

/**
 * How a web list page is split into items. Every selector is evaluated inside one item
 * element; a null selector falls back to the first link of the item and the first date-like
 * text in it.
 */
export interface WebListHTMLExtraction {
  dateSelector: string | null
  itemSelector: string | null
  linkSelector: string | null
  summarySelector: string | null
  titleSelector: string | null
}

export type WebListPublishedAtFormat = "auto" | "unix_milliseconds" | "unix_seconds"

/**
 * Dot paths into a JSON document, for example `data.list` or `items[0].title`. An empty
 * `itemsPath` addresses the document root.
 */
export interface WebListJSONExtraction {
  idPath: string | null
  itemsPath: string
  /** Display label to item path, rendered as a fact header above the content (e.g. 文号). */
  metadataPaths: Record<string, string>
  publishedAtFormat: WebListPublishedAtFormat
  publishedAtPath: string | null
  summaryPath: string | null
  titlePath: string
  urlBase: string | null
  urlPath: string | null
  urlTemplate: string | null
}

export interface WebListFilters {
  excludeTextPatterns: string[]
  excludeURLPatterns: string[]
  includeTextPatterns: string[]
  includeURLPatterns: string[]
}

export interface WebListDetailExtraction {
  contentSelectors: string[]
  enabled: boolean
  ignoreSelectors: string[]
}

export interface WebListSource {
  consecutiveFailures: number
  createdAt: string
  deletedAt: string | null
  detail: WebListDetailExtraction
  enabled: boolean
  feedURL: string
  filters: WebListFilters
  format: WebListFormat
  html: WebListHTMLExtraction | null
  id: string
  intervalMinutes: number | null
  itemCount: number
  json: WebListJSONExtraction | null
  lastAttemptAt: string | null
  lastErrorCode: string | null
  lastErrorSummary: string | null
  lastSuccessAt: string | null
  maxItems: number
  maxPages: number
  name: string
  nextCheckAt: string | null
  targetURL: string
  /** IANA time zone used for dates that carry no offset, such as `2026-09-01`. */
  timeZone: string
  updatedAt: string
}

export type WebListDetailStatus = "failed" | "fetched" | "skipped"

export interface WebListItem {
  content: string | null
  detailStatus: WebListDetailStatus
  discoveredAt: string
  guid: string
  id: string
  publishedAt: string | null
  sourceId: string
  summary: string | null
  title: string
  url: string
}

/** Body of a create request; omitted fields take the supplier defaults. */
export interface WebListSourceInput {
  detail?: Partial<WebListDetailExtraction>
  enabled?: boolean
  filters?: Partial<WebListFilters>
  format: WebListFormat
  html?: Partial<WebListHTMLExtraction> | null
  intervalMinutes?: number | null
  json?: (Partial<WebListJSONExtraction> & Pick<WebListJSONExtraction, "titlePath">) | null
  maxItems?: number
  maxPages?: number
  name: string
  targetURL: string
  timeZone?: string
}

/** Body of an update request; only the fields sent change, nested objects are replaced. */
export type WebListSourcePatch = Partial<WebListSourceInput>

export interface WebListPreviewItem {
  metadata: [label: string, value: string][]
  publishedAt: string | null
  summary: string | null
  title: string
  url: string
}

export interface WebListTestResult {
  detail: {
    content: string | null
    detailStatus: WebListDetailStatus
    publishedAt: string | null
    title: string
  } | null
  finalURL: string
  items: WebListPreviewItem[]
  pagesRead: number
}

export interface WebListCheckResult {
  publishedCount: number
  source: WebListSource
  status: "items_published" | "unchanged"
}

export interface ParsedWebListSource {
  logicalURL: string
  sourceId: string
}

export interface ParsedPageChangeSource {
  logicalURL: string
  sourceId: string
}

const maximumSourceURLLength = 2_048
const sourceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const pageChangeFeedURL = (sourceId: string): string => {
  if (!sourceIdPattern.test(sourceId)) {
    throw new Error("Page change source ID must be a UUID")
  }
  return `pagechange://${sourceId.toLowerCase()}`
}

export const webListFeedURL = (sourceId: string): string => {
  if (!sourceIdPattern.test(sourceId)) {
    throw new Error("Web list source ID must be a UUID")
  }
  return `weblist://${sourceId.toLowerCase()}`
}

export const parseWebListSource = (input: string): ParsedWebListSource => {
  let sourceURL: URL
  try {
    sourceURL = new URL(input)
  } catch {
    throw new Error("Web list source URL is invalid")
  }
  if (sourceURL.protocol !== "weblist:") {
    throw new Error("Web list source URL must use the weblist:// scheme")
  }
  if (sourceURL.username || sourceURL.password || sourceURL.port || sourceURL.pathname !== "") {
    throw new Error("Web list source URL must contain only a source ID")
  }
  if (sourceURL.search || sourceURL.hash) {
    throw new Error("Web list source URL must not contain a query or fragment")
  }
  return {
    logicalURL: webListFeedURL(sourceURL.hostname),
    sourceId: sourceURL.hostname.toLowerCase(),
  }
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

/**
 * A consumer allowed to read sources through public subscription links (ADR-0033), such as
 * official Folo or a phone reader. Revoking it disables every link it holds.
 */
export interface PublicFeedGrant {
  id: string
  name: string
  createdAt: string
  revokedAt: string | null
  activeLinkCount: number
  /** Latest access across the grant's links */
  lastAccessAt: string | null
  lastAccessIP: string | null
  lastAccessUserAgent: string | null
}

/** One source exposed to one grant under its own unguessable link. */
export interface PublicFeedLink {
  id: string
  grantId: string
  /** Logical source address: rsshub://, pagechange:// or weblist:// */
  sourceURL: string
  /** Reader-facing title and category, usually taken from the subscription preset */
  title: string | null
  category: string | null
  createdAt: string
  rotatedAt: string | null
  revokedAt: string | null
  lastAccessAt: string | null
  lastAccessIP: string | null
  lastAccessUserAgent: string | null
}

/** A link together with its subscription URL; only returned when issued or exported. */
export interface IssuedPublicFeedLink extends PublicFeedLink {
  url: string
}

/**
 * Which personal credentials a source depends on (ADR-0033). `uses` when any credential is
 * bound or declared, `none` when the source is known to need none, `unknown` otherwise.
 */
export interface SourceCredentialDependency {
  status: "none" | "unknown" | "uses"
  /** Names of supplier credentials bound to the route's secret query parameters */
  boundCredentials: string[]
  /** RSSHub deployment credentials declared on the matching catalog template */
  rssHubCredentials: RssHubCredentialRequirement[]
  /** Key of the catalog template the address matched, if any */
  catalogRouteKey: string | null
}

export interface PublicFeedCredentialUsage {
  grantId: string
  grantName: string
  linkId: string
  sourceURL: string
  title: string | null
  category: string | null
  dependency: SourceCredentialDependency
}

/** Every active public link with its credential dependency, for the owner's overview. */
export interface CredentialUsageReport {
  links: PublicFeedCredentialUsage[]
}
