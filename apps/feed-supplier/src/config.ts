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

const postgresURL = z.url().transform((value, context) => {
  const url = new URL(value)
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    context.addIssue({ code: "custom", message: "DATABASE_URL must use PostgreSQL" })
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
    HOST: z.string().default("0.0.0.0"),
    INTERNAL_TOKEN: z.string().min(32),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PAGE_CONTENT_MAX_BYTES: integer(256 * 1024, 1_024).pipe(z.number().max(512 * 1024)),
    PAGE_FETCH_MAX_BYTES: integer(5 * 1024 * 1024, 1_024),
    PAGE_FETCH_TIMEOUT_MS: integer(15_000, 1_000),
    PAGE_SCHEDULER_POLL_INTERVAL_MS: integer(60_000, 1_000),
    PORT: integer(3001, 1).pipe(z.number().max(65_535)),
    ROUTE_REGISTRY_MODE: z.enum(["permissive", "managed_only"]).default("permissive"),
    RSSHUB_ACCESS_KEY: z.string().min(16).optional(),
    RSSHUB_BASE_URL: upstreamURL.default("http://localhost:1200"),
    RSSHUB_FETCH_MAX_BYTES: integer(5 * 1024 * 1024, 1024),
    RSSHUB_FETCH_TIMEOUT_MS: integer(30_000, 1_000),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== "production") return

    if (!environment.DATABASE_URL) {
      context.addIssue({
        code: "custom",
        message: "Production requires an independent DATABASE_URL",
        path: ["DATABASE_URL"],
      })
    }
    if (!environment.RSSHUB_ACCESS_KEY) {
      context.addIssue({
        code: "custom",
        message: "Production requires RSSHUB_ACCESS_KEY",
        path: ["RSSHUB_ACCESS_KEY"],
      })
    }
    for (const key of ["ADMIN_TOKEN", "INTERNAL_TOKEN", "RSSHUB_ACCESS_KEY"] as const) {
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
    host: parsed.HOST,
    internalToken: parsed.INTERNAL_TOKEN,
    nodeEnvironment: parsed.NODE_ENV,
    pageContentMaxBytes: parsed.PAGE_CONTENT_MAX_BYTES,
    pageFetchMaxBytes: parsed.PAGE_FETCH_MAX_BYTES,
    pageFetchTimeoutMs: parsed.PAGE_FETCH_TIMEOUT_MS,
    pageSchedulerPollIntervalMs: parsed.PAGE_SCHEDULER_POLL_INTERVAL_MS,
    port: parsed.PORT,
    registryMode: parsed.ROUTE_REGISTRY_MODE as SourceRegistryMode,
    rssHubAccessKey: parsed.RSSHUB_ACCESS_KEY,
    rssHubBaseURL: parsed.RSSHUB_BASE_URL,
    rssHubFetchMaxBytes: parsed.RSSHUB_FETCH_MAX_BYTES,
    rssHubFetchTimeoutMs: parsed.RSSHUB_FETCH_TIMEOUT_MS,
  }
}

export type FeedSupplierConfig = ReturnType<typeof loadFeedSupplierConfig>
