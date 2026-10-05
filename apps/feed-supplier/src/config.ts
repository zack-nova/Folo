import { isIP } from "node:net"

import type { SourceRegistryMode } from "@follow/feed-source-contracts"
import { z } from "zod"

const developmentEncryptionKey = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="
const developmentAuditKey = "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws="

const integer = (defaultValue: number, minimum: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? defaultValue : Number(value)),
    z.number().int().min(minimum),
  )

const upstreamURL = z.url().transform((value, context) => {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "RSSHUB_BASE_URL must use HTTP or HTTPS" })
    return z.NEVER
  }
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({
      code: "custom",
      message: "RSSHUB_BASE_URL must not contain credentials, a query, or a fragment",
    })
    return z.NEVER
  }
  return url.toString().replace(/\/$/, "")
})

/** Public base of the subscription links (ADR-0033); empty disables the public channel. */
const publicFeedBaseURL = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .url()
    .transform((value, context) => {
      const url = new URL(value)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        context.addIssue({ code: "custom", message: "PUBLIC_FEED_BASE_URL must use HTTP or HTTPS" })
        return z.NEVER
      }
      // Links are served at /f/<token> on this origin, so a path would produce dead links.
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        context.addIssue({
          code: "custom",
          message: "PUBLIC_FEED_BASE_URL must be an origin without a path, query or credentials",
        })
        return z.NEVER
      }
      return url.origin
    })
    .optional(),
)

/** Optional URL without credentials, query or fragment; empty disables the feature. */
const optionalServiceURL = (name: string, allowCredentials = false) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .url()
      .transform((value, context) => {
        const url = new URL(value)
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          context.addIssue({ code: "custom", message: `${name} must use HTTP or HTTPS` })
          return z.NEVER
        }
        if (
          (!allowCredentials && (url.username || url.password)) ||
          url.search ||
          url.hash ||
          url.pathname !== "/"
        ) {
          context.addIssue({
            code: "custom",
            message: `${name} must be an origin without a path, query${
              allowCredentials ? "" : " or credentials"
            }`,
          })
          return z.NEVER
        }
        return allowCredentials ? url.toString().replace(/\/$/, "") : url.origin
      })
      .optional(),
  )

/** Named ranges understood by proxy-addr, which Fastify uses to evaluate `trustProxy`. */
const trustedProxyPresets = new Set(["linklocal", "loopback", "uniquelocal"])

const isTrustedProxyEntry = (entry: string) => {
  if (trustedProxyPresets.has(entry) || isIP(entry) !== 0) return true
  const [address, prefix, ...rest] = entry.split("/")
  const version = address ? isIP(address) : 0
  if (version === 0 || prefix === undefined || rest.length > 0 || !/^\d+$/.test(prefix)) {
    return false
  }
  return Number(prefix) <= (version === 4 ? 32 : 128)
}

/** Reverse proxies whose X-Forwarded-For is believed; same format as the core's TRUST_PROXY. */
const trustedProxies = z
  .string()
  .default("")
  .transform((value, context) => {
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
    const invalid = entries.filter((entry) => !isTrustedProxyEntry(entry))
    if (invalid.length > 0) {
      context.addIssue({
        code: "custom",
        message: `TRUST_PROXY entries must be IP addresses, CIDR ranges or one of ${[
          ...trustedProxyPresets,
        ].join(", ")}: ${invalid.join(", ")}`,
      })
      return z.NEVER
    }
    return entries
  })

const postgresURL = z.url().transform((value, context) => {
  const url = new URL(value)
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    context.addIssue({ code: "custom", message: "DATABASE_URL must use PostgreSQL" })
    return z.NEVER
  }
  return value
})

const redisURL = z.url().transform((value, context) => {
  const url = new URL(value)
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    context.addIssue({ code: "custom", message: "REDIS_URL must use Redis or Redis TLS" })
    return z.NEVER
  }
  if (url.hash) {
    context.addIssue({ code: "custom", message: "REDIS_URL must not contain a fragment" })
    return z.NEVER
  }
  return value
})

const keyId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w.-]+$/)

const decodeEncryptionKey = (value: string, name: string): Buffer => {
  if (!/^[A-Z0-9+/]{43}=$/i.test(value)) {
    throw new Error(`${name} must be a base64-encoded 32-byte key`)
  }
  const key = Buffer.from(value, "base64")
  if (key.byteLength !== 32) throw new Error(`${name} must decode to exactly 32 bytes`)
  return key
}

const parseOldEncryptionKeys = (value: string): Record<string, string> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("CREDENTIAL_DECRYPTION_KEYS_JSON must be valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CREDENTIAL_DECRYPTION_KEYS_JSON must be a JSON object")
  }
  const entries = Object.entries(parsed)
  if (entries.length > 8) throw new Error("At most 8 historical credential keys are supported")
  const result: Record<string, string> = {}
  for (const [id, encodedKey] of entries) {
    keyId.parse(id)
    if (typeof encodedKey !== "string") {
      throw new TypeError(`Historical credential key ${id} must be a string`)
    }
    decodeEncryptionKey(encodedKey, `Historical credential key ${id}`)
    result[id] = encodedKey
  }
  return result
}

const supplierEnvironment = z
  .object({
    ADMIN_TOKEN: z
      .string()
      .min(32)
      .default("local-feed-supplier-admin-token-at-least-32-characters"),
    AUDIT_HMAC_KEY: z.string().default(developmentAuditKey),
    CREDENTIAL_DECRYPTION_KEYS_JSON: z.string().default("{}"),
    CREDENTIAL_ENCRYPTION_KEY: z.string().default(developmentEncryptionKey),
    CREDENTIAL_ENCRYPTION_KEY_ID: keyId.default("local-primary"),
    DATABASE_MAX_CONNECTIONS: integer(10, 1).pipe(z.number().max(50)),
    DATABASE_URL: postgresURL.optional(),
    // Official Folo acquisition (ADR-0034); without the API URL the feature does not exist.
    FOLO_OFFICIAL_API_URL: optionalServiceURL("FOLO_OFFICIAL_API_URL"),
    FOLO_OFFICIAL_CACHE_TTL_SECONDS: integer(300, 60).pipe(z.number().max(3_600)),
    FOLO_OFFICIAL_CONCURRENCY: integer(2, 1).pipe(z.number().max(8)),
    // The official API page holds at most 100 entries.
    FOLO_OFFICIAL_ENTRY_LIMIT: integer(50, 1).pipe(z.number().max(100)),
    FOLO_OFFICIAL_FETCH_TIMEOUT_MS: integer(30_000, 1_000).pipe(z.number().max(60_000)),
    // Outbound HTTP proxy used for the official API only; mainland China nodes need one.
    FOLO_OFFICIAL_PROXY_URL: optionalServiceURL("FOLO_OFFICIAL_PROXY_URL", true),
    FOLO_OFFICIAL_RATE_LIMIT_MAX: integer(30, 1).pipe(z.number().max(1_000)),
    FOLO_OFFICIAL_RATE_LIMIT_WINDOW_SECONDS: integer(60, 1).pipe(z.number().max(3_600)),
    HOST: z.string().default("0.0.0.0"),
    INTERNAL_TOKEN: z.string().min(32),
    // Optional third token held by the Folo core to manage web list sources for the owner.
    MANAGEMENT_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32).optional(),
    ),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    WEB_LIST_FETCH_TIMEOUT_MS: integer(15_000, 1_000).pipe(z.number().max(60_000)),
    WEB_LIST_FETCH_MAX_BYTES: integer(5 * 1024 * 1024, 1_024),
    WEB_LIST_REQUEST_DELAY_MS: integer(500, 0).pipe(z.number().max(30_000)),
    WEB_LIST_SCHEDULER_POLL_INTERVAL_MS: integer(60_000, 1_000),
    PAGE_CONTENT_MAX_BYTES: integer(256 * 1024, 1_024).pipe(z.number().max(512 * 1024)),
    PAGE_FETCH_MAX_BYTES: integer(5 * 1024 * 1024, 1_024),
    PAGE_FETCH_TIMEOUT_MS: integer(15_000, 1_000),
    PAGE_SCHEDULER_POLL_INTERVAL_MS: integer(60_000, 1_000),
    PORT: integer(3001, 1).pipe(z.number().max(65_535)),
    PUBLIC_FEED_BASE_URL: publicFeedBaseURL,
    REDIS_CONNECT_TIMEOUT_MS: integer(5_000, 500).pipe(z.number().max(30_000)),
    REDIS_URL: redisURL.optional(),
    ROUTE_REGISTRY_MODE: z.enum(["permissive", "managed_only"]).default("permissive"),
    RSSHUB_ACCESS_KEY: z.string().min(16).optional(),
    RSSHUB_BASE_URL: upstreamURL.default("http://localhost:1200"),
    RSSHUB_CACHE_TTL_SECONDS: integer(60, 1).pipe(z.number().max(3_600)),
    RSSHUB_FETCH_MAX_BYTES: integer(5 * 1024 * 1024, 1024),
    RSSHUB_FETCH_TIMEOUT_MS: integer(30_000, 1_000),
    RSSHUB_GLOBAL_CONCURRENCY: integer(16, 1).pipe(z.number().max(128)),
    RSSHUB_ROUTE_CONCURRENCY: integer(4, 1).pipe(z.number().max(32)),
    RSSHUB_ROUTE_RATE_LIMIT_MAX: integer(60, 1).pipe(z.number().max(10_000)),
    RSSHUB_ROUTE_RATE_LIMIT_WINDOW_SECONDS: integer(60, 1).pipe(z.number().max(3_600)),
    TRUST_PROXY: trustedProxies,
  })
  .superRefine((environment, context) => {
    // The management token is checked in every environment: sharing it with the admin or
    // internal token would silently widen what the Folo core can reach.
    if (
      environment.MANAGEMENT_TOKEN &&
      [environment.ADMIN_TOKEN, environment.INTERNAL_TOKEN, environment.RSSHUB_ACCESS_KEY].includes(
        environment.MANAGEMENT_TOKEN,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "MANAGEMENT_TOKEN must differ from every other supplier secret",
        path: ["MANAGEMENT_TOKEN"],
      })
    }
    if (environment.NODE_ENV !== "production") return

    if (!environment.DATABASE_URL) {
      context.addIssue({
        code: "custom",
        message: "Production requires an independent DATABASE_URL",
        path: ["DATABASE_URL"],
      })
    }
    if (
      environment.FOLO_OFFICIAL_API_URL &&
      new URL(environment.FOLO_OFFICIAL_API_URL).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        message: "Production FOLO_OFFICIAL_API_URL must use HTTPS",
        path: ["FOLO_OFFICIAL_API_URL"],
      })
    }
    if (
      environment.PUBLIC_FEED_BASE_URL &&
      new URL(environment.PUBLIC_FEED_BASE_URL).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        message: "Production PUBLIC_FEED_BASE_URL must use HTTPS",
        path: ["PUBLIC_FEED_BASE_URL"],
      })
    }
    // Behind the reverse proxy every client would otherwise share its address, and one client
    // presenting unknown links could exhaust the miss budget of everyone else.
    if (environment.PUBLIC_FEED_BASE_URL && environment.TRUST_PROXY.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Production public links require TRUST_PROXY for the reverse proxy",
        path: ["TRUST_PROXY"],
      })
    }
    if (!environment.REDIS_URL) {
      context.addIssue({
        code: "custom",
        message: "Production requires REDIS_URL for source scaling",
        path: ["REDIS_URL"],
      })
    }
    if (!environment.RSSHUB_ACCESS_KEY) {
      context.addIssue({
        code: "custom",
        message: "Production requires RSSHUB_ACCESS_KEY",
        path: ["RSSHUB_ACCESS_KEY"],
      })
    }
    for (const key of [
      "ADMIN_TOKEN",
      "INTERNAL_TOKEN",
      "MANAGEMENT_TOKEN",
      "RSSHUB_ACCESS_KEY",
    ] as const) {
      const value = environment[key]
      if (value && /replace-with|development|example|local-/i.test(value)) {
        context.addIssue({
          code: "custom",
          message: `${key} still looks like a placeholder`,
          path: [key],
        })
      }
    }
    if (environment.RSSHUB_ACCESS_KEY === environment.INTERNAL_TOKEN) {
      context.addIssue({
        code: "custom",
        message: "RSSHUB_ACCESS_KEY must differ from INTERNAL_TOKEN",
        path: ["RSSHUB_ACCESS_KEY"],
      })
    }
    if (environment.ADMIN_TOKEN === environment.INTERNAL_TOKEN) {
      context.addIssue({
        code: "custom",
        message: "ADMIN_TOKEN must differ from INTERNAL_TOKEN",
        path: ["ADMIN_TOKEN"],
      })
    }
    if (environment.CREDENTIAL_ENCRYPTION_KEY === developmentEncryptionKey) {
      context.addIssue({
        code: "custom",
        message: "Production requires a generated CREDENTIAL_ENCRYPTION_KEY",
        path: ["CREDENTIAL_ENCRYPTION_KEY"],
      })
    }
    if (environment.AUDIT_HMAC_KEY === developmentAuditKey) {
      context.addIssue({
        code: "custom",
        message: "Production requires a generated AUDIT_HMAC_KEY",
        path: ["AUDIT_HMAC_KEY"],
      })
    }
    if (environment.AUDIT_HMAC_KEY === environment.CREDENTIAL_ENCRYPTION_KEY) {
      context.addIssue({
        code: "custom",
        message: "AUDIT_HMAC_KEY must differ from CREDENTIAL_ENCRYPTION_KEY",
        path: ["AUDIT_HMAC_KEY"],
      })
    }
  })

export const loadFeedSupplierConfig = (environment: NodeJS.ProcessEnv) => {
  const parsed = supplierEnvironment.parse(environment)
  const oldKeys = parseOldEncryptionKeys(parsed.CREDENTIAL_DECRYPTION_KEYS_JSON)
  const credentialKeys = new Map<string, Buffer>()
  for (const [id, encodedKey] of Object.entries(oldKeys)) {
    credentialKeys.set(id, decodeEncryptionKey(encodedKey, `Historical credential key ${id}`))
  }
  credentialKeys.set(
    parsed.CREDENTIAL_ENCRYPTION_KEY_ID,
    decodeEncryptionKey(parsed.CREDENTIAL_ENCRYPTION_KEY, "CREDENTIAL_ENCRYPTION_KEY"),
  )
  return {
    adminToken: parsed.ADMIN_TOKEN,
    auditHmacKey: decodeEncryptionKey(parsed.AUDIT_HMAC_KEY, "AUDIT_HMAC_KEY"),
    credentialActiveKeyId: parsed.CREDENTIAL_ENCRYPTION_KEY_ID,
    credentialKeys,
    databaseMaxConnections: parsed.DATABASE_MAX_CONNECTIONS,
    databaseURL: parsed.DATABASE_URL,
    officialAcquisition: parsed.FOLO_OFFICIAL_API_URL
      ? {
          apiURL: parsed.FOLO_OFFICIAL_API_URL,
          cacheTTLSeconds: parsed.FOLO_OFFICIAL_CACHE_TTL_SECONDS,
          concurrency: parsed.FOLO_OFFICIAL_CONCURRENCY,
          entryLimit: parsed.FOLO_OFFICIAL_ENTRY_LIMIT,
          fetchTimeoutMs: parsed.FOLO_OFFICIAL_FETCH_TIMEOUT_MS,
          proxyURL: parsed.FOLO_OFFICIAL_PROXY_URL ?? null,
          rateLimitMax: parsed.FOLO_OFFICIAL_RATE_LIMIT_MAX,
          rateLimitWindowSeconds: parsed.FOLO_OFFICIAL_RATE_LIMIT_WINDOW_SECONDS,
        }
      : null,
    host: parsed.HOST,
    internalToken: parsed.INTERNAL_TOKEN,
    managementToken: parsed.MANAGEMENT_TOKEN ?? null,
    nodeEnvironment: parsed.NODE_ENV,
    webListFetchTimeoutMs: parsed.WEB_LIST_FETCH_TIMEOUT_MS,
    webListFetchMaxBytes: parsed.WEB_LIST_FETCH_MAX_BYTES,
    webListRequestDelayMs: parsed.WEB_LIST_REQUEST_DELAY_MS,
    webListSchedulerPollIntervalMs: parsed.WEB_LIST_SCHEDULER_POLL_INTERVAL_MS,
    pageContentMaxBytes: parsed.PAGE_CONTENT_MAX_BYTES,
    pageFetchMaxBytes: parsed.PAGE_FETCH_MAX_BYTES,
    pageFetchTimeoutMs: parsed.PAGE_FETCH_TIMEOUT_MS,
    pageSchedulerPollIntervalMs: parsed.PAGE_SCHEDULER_POLL_INTERVAL_MS,
    port: parsed.PORT,
    publicFeedBaseURL: parsed.PUBLIC_FEED_BASE_URL ?? null,
    redisConnectTimeoutMs: parsed.REDIS_CONNECT_TIMEOUT_MS,
    redisURL: parsed.REDIS_URL,
    registryMode: parsed.ROUTE_REGISTRY_MODE as SourceRegistryMode,
    rssHubAccessKey: parsed.RSSHUB_ACCESS_KEY,
    rssHubBaseURL: parsed.RSSHUB_BASE_URL,
    rssHubCacheTTLSeconds: parsed.RSSHUB_CACHE_TTL_SECONDS,
    rssHubFetchMaxBytes: parsed.RSSHUB_FETCH_MAX_BYTES,
    rssHubFetchTimeoutMs: parsed.RSSHUB_FETCH_TIMEOUT_MS,
    rssHubGlobalConcurrency: parsed.RSSHUB_GLOBAL_CONCURRENCY,
    rssHubRouteConcurrency: parsed.RSSHUB_ROUTE_CONCURRENCY,
    rssHubRouteRateLimitMax: parsed.RSSHUB_ROUTE_RATE_LIMIT_MAX,
    rssHubRouteRateLimitWindowSeconds: parsed.RSSHUB_ROUTE_RATE_LIMIT_WINDOW_SECONDS,
    trustProxy: parsed.TRUST_PROXY,
  }
}

export type FeedSupplierConfig = ReturnType<typeof loadFeedSupplierConfig>
