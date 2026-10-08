import { isIP } from "node:net"

import { z } from "zod"

const integer = (defaultValue: number, minimum: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? defaultValue : Number(value)),
    z.number().int().min(minimum),
  )

const boolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true")

const internalServiceURL = z.url().transform((value, context) => {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "Internal service URL must use HTTP or HTTPS" })
    return z.NEVER
  }
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({
      code: "custom",
      message: "Internal service URL must not contain credentials, a query, or a fragment",
    })
    return z.NEVER
  }
  return url.toString().replace(/\/$/, "")
})

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

/** Comma-separated addresses, CIDR ranges or presets of the reverse proxies to trust. */
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

const serverEnvironment = z
  .object({
    AI_API_KEY: z.string().min(1).optional(),
    // Owner's Codex CLI as a low-volume provider; the command path enables it.
    AI_CODEX_COMMAND: z.string().min(1).optional(),
    AI_CODEX_DAILY_LIMIT: integer(200, 1).pipe(z.number().max(10_000)),
    AI_CODEX_HOME: z.string().min(1).default("/data/codex"),
    AI_CODEX_MODEL: z.string().min(1).optional(),
    AI_CODEX_SCOPE: z.enum(["all", "manual"]).default("manual"),
    AI_CODEX_TIMEOUT_MS: integer(180_000, 10_000).pipe(z.number().max(900_000)),
    AI_CODEX_WORKDIR: z.string().min(1).default("/tmp/codex-work"),
    AI_ENCRYPTION_SECRET: z.string().min(32).optional(),
    AI_PROVIDER_BASE_URL: z.url().default("https://api.openai.com/v1"),
    AI_PROVIDER_MODEL: z.string().min(1).default("gpt-4o-mini"),
    AI_PROVIDER_TIMEOUT_MS: integer(60_000, 1_000),
    ALLOW_INSECURE_HTTP: boolean,
    ALLOW_PUBLIC_REGISTRATION: boolean,
    ALLOW_PRIVATE_FEEDS: boolean,
    API_RATE_LIMIT_MAX: integer(600, 1),
    AUTH_RATE_LIMIT_MAX: integer(30, 1),
    BETTER_AUTH_SECRET: z.string().min(32),
    CLIENT_ORIGINS: z
      .string()
      .default("http://localhost:2233")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.url()).min(1)),
    DATABASE_URL: z.url().refine((value) => {
      const protocol = new URL(value).protocol
      return protocol === "postgres:" || protocol === "postgresql:"
    }, "DATABASE_URL must use postgres:// or postgresql://"),
    FEED_FETCH_MAX_BYTES: integer(5 * 1024 * 1024, 1024),
    FEED_FETCH_TIMEOUT_MS: integer(15_000, 1000),
    FEED_POLL_INTERVAL_MS: integer(15 * 60 * 1000, 60_000),
    FEED_POLL_CONCURRENCY: integer(4, 1).pipe(z.number().max(32)),
    FEED_RETRY_BASE_DELAY_MS: integer(60_000, 1_000),
    // Optional token that lets the owner manage web list sources through the core.
    FEED_SUPPLIER_MANAGEMENT_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32).optional(),
    ),
    FEED_SUPPLIER_TOKEN: z.string().min(32).optional(),
    FEED_SUPPLIER_URL: internalServiceURL.optional(),
    HOST: z.string().default("0.0.0.0"),
    METRICS_TOKEN: z.string().min(32).optional(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: integer(3000, 1).pipe(z.number().max(65_535)),
    PROCESSING_MAX_ATTEMPTS: integer(3, 1).pipe(z.number().max(10)),
    PROCESSING_MAX_CONTENT_CHARS: integer(12_000, 1_000).pipe(z.number().max(200_000)),
    PROCESSING_RETRY_BASE_DELAY_MS: integer(1_000, 1),
    PROCESSING_WORKER_POLL_INTERVAL_MS: integer(1_000, 10),
    SERVER_URL: z.url().default("http://localhost:3000"),
    TRUST_PROXY: trustedProxies,
    /** Removed; kept in the schema only to reject configurations that still set it. */
    TRUST_PROXY_HOPS: z.string().optional(),
    UPLOADS_DIRECTORY: z.string().min(1).default("./data/uploads"),
  })
  .superRefine((environment, context) => {
    // Fastify 5.12 ignores hop counts because they trust whoever connects directly. Fail
    // loudly instead of silently rate limiting every client as the proxy.
    if (environment.TRUST_PROXY_HOPS && environment.TRUST_PROXY_HOPS !== "0") {
      context.addIssue({
        code: "custom",
        message:
          "TRUST_PROXY_HOPS is no longer supported; list the reverse proxy addresses in " +
          "TRUST_PROXY instead (for the production Compose topology: loopback,uniquelocal)",
        path: ["TRUST_PROXY_HOPS"],
      })
    }
    if (Boolean(environment.FEED_SUPPLIER_URL) !== Boolean(environment.FEED_SUPPLIER_TOKEN)) {
      context.addIssue({
        code: "custom",
        message: "FEED_SUPPLIER_URL and FEED_SUPPLIER_TOKEN must be configured together",
        path: [environment.FEED_SUPPLIER_URL ? "FEED_SUPPLIER_TOKEN" : "FEED_SUPPLIER_URL"],
      })
    }
    if (environment.FEED_SUPPLIER_MANAGEMENT_TOKEN && !environment.FEED_SUPPLIER_URL) {
      context.addIssue({
        code: "custom",
        message: "FEED_SUPPLIER_MANAGEMENT_TOKEN requires FEED_SUPPLIER_URL",
        path: ["FEED_SUPPLIER_MANAGEMENT_TOKEN"],
      })
    }
    if (
      environment.FEED_SUPPLIER_MANAGEMENT_TOKEN &&
      environment.FEED_SUPPLIER_MANAGEMENT_TOKEN === environment.FEED_SUPPLIER_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        message: "FEED_SUPPLIER_MANAGEMENT_TOKEN must differ from FEED_SUPPLIER_TOKEN",
        path: ["FEED_SUPPLIER_MANAGEMENT_TOKEN"],
      })
    }
    if (environment.NODE_ENV !== "production") return

    if (environment.ALLOW_PRIVATE_FEEDS && environment.ALLOW_PUBLIC_REGISTRATION) {
      context.addIssue({
        code: "custom",
        message: "Public registration cannot be combined with private-network feed access",
        path: ["ALLOW_PRIVATE_FEEDS"],
      })
    }

    const insecureURLs = [environment.SERVER_URL, ...environment.CLIENT_ORIGINS].filter(
      (value) => new URL(value).protocol !== "https:",
    )
    if (insecureURLs.length > 0 && !environment.ALLOW_INSECURE_HTTP) {
      context.addIssue({
        code: "custom",
        message: "Production SERVER_URL and CLIENT_ORIGINS must use HTTPS",
        path: ["SERVER_URL"],
      })
    }
    if (!environment.AI_ENCRYPTION_SECRET) {
      context.addIssue({
        code: "custom",
        message: "Production requires an independent AI_ENCRYPTION_SECRET",
        path: ["AI_ENCRYPTION_SECRET"],
      })
    } else if (environment.AI_ENCRYPTION_SECRET === environment.BETTER_AUTH_SECRET) {
      context.addIssue({
        code: "custom",
        message: "AI_ENCRYPTION_SECRET must differ from BETTER_AUTH_SECRET",
        path: ["AI_ENCRYPTION_SECRET"],
      })
    }
    if (!environment.METRICS_TOKEN) {
      context.addIssue({
        code: "custom",
        message: "Production requires METRICS_TOKEN to protect operational metrics",
        path: ["METRICS_TOKEN"],
      })
    } else if (
      environment.METRICS_TOKEN === environment.BETTER_AUTH_SECRET ||
      environment.METRICS_TOKEN === environment.AI_ENCRYPTION_SECRET
    ) {
      context.addIssue({
        code: "custom",
        message: "METRICS_TOKEN must differ from authentication and AI encryption secrets",
        path: ["METRICS_TOKEN"],
      })
    }
    if (/replace-with|development|example/i.test(environment.BETTER_AUTH_SECRET)) {
      context.addIssue({
        code: "custom",
        message: "BETTER_AUTH_SECRET still looks like a placeholder",
        path: ["BETTER_AUTH_SECRET"],
      })
    }
    if (
      environment.AI_ENCRYPTION_SECRET &&
      /replace-with|development|example/i.test(environment.AI_ENCRYPTION_SECRET)
    ) {
      context.addIssue({
        code: "custom",
        message: "AI_ENCRYPTION_SECRET still looks like a placeholder",
        path: ["AI_ENCRYPTION_SECRET"],
      })
    }
    if (
      environment.METRICS_TOKEN &&
      /replace-with|development|example/i.test(environment.METRICS_TOKEN)
    ) {
      context.addIssue({
        code: "custom",
        message: "METRICS_TOKEN still looks like a placeholder",
        path: ["METRICS_TOKEN"],
      })
    }
    if (
      environment.FEED_SUPPLIER_TOKEN &&
      (environment.FEED_SUPPLIER_TOKEN === environment.BETTER_AUTH_SECRET ||
        environment.FEED_SUPPLIER_TOKEN === environment.AI_ENCRYPTION_SECRET ||
        environment.FEED_SUPPLIER_TOKEN === environment.METRICS_TOKEN)
    ) {
      context.addIssue({
        code: "custom",
        message: "FEED_SUPPLIER_TOKEN must differ from authentication, AI, and metrics secrets",
        path: ["FEED_SUPPLIER_TOKEN"],
      })
    }
    if (
      environment.FEED_SUPPLIER_TOKEN &&
      /replace-with|development|example/i.test(environment.FEED_SUPPLIER_TOKEN)
    ) {
      context.addIssue({
        code: "custom",
        message: "FEED_SUPPLIER_TOKEN still looks like a placeholder",
        path: ["FEED_SUPPLIER_TOKEN"],
      })
    }
  })

export const loadServerConfig = (environment: NodeJS.ProcessEnv) => {
  const parsed = serverEnvironment.parse(environment)
  return {
    aiCodexConfig: parsed.AI_CODEX_COMMAND
      ? {
          codexHome: parsed.AI_CODEX_HOME,
          command: parsed.AI_CODEX_COMMAND,
          dailyLimit: parsed.AI_CODEX_DAILY_LIMIT,
          model: parsed.AI_CODEX_MODEL ?? null,
          scope: parsed.AI_CODEX_SCOPE,
          timeoutMs: parsed.AI_CODEX_TIMEOUT_MS,
          workDirectory: parsed.AI_CODEX_WORKDIR,
        }
      : undefined,
    aiEncryptionSecret: parsed.AI_ENCRYPTION_SECRET ?? parsed.BETTER_AUTH_SECRET,
    aiProviderConfig: parsed.AI_API_KEY
      ? {
          apiKey: parsed.AI_API_KEY,
          baseUrl: parsed.AI_PROVIDER_BASE_URL.replace(/\/$/, ""),
          model: parsed.AI_PROVIDER_MODEL,
          timeoutMs: parsed.AI_PROVIDER_TIMEOUT_MS,
        }
      : undefined,
    apiRateLimitMax: parsed.API_RATE_LIMIT_MAX,
    allowPublicRegistration: parsed.ALLOW_PUBLIC_REGISTRATION,
    allowPrivateFeeds: parsed.ALLOW_PRIVATE_FEEDS,
    authSecret: parsed.BETTER_AUTH_SECRET,
    authRateLimitMax: parsed.AUTH_RATE_LIMIT_MAX,
    clientOrigins: parsed.CLIENT_ORIGINS,
    databaseURL: parsed.DATABASE_URL,
    feedFetchMaxBytes: parsed.FEED_FETCH_MAX_BYTES,
    feedFetchTimeoutMs: parsed.FEED_FETCH_TIMEOUT_MS,
    feedPollConcurrency: parsed.FEED_POLL_CONCURRENCY,
    feedPollIntervalMs: parsed.FEED_POLL_INTERVAL_MS,
    feedRetryBaseDelayMs: parsed.FEED_RETRY_BASE_DELAY_MS,
    feedSupplierConfig:
      parsed.FEED_SUPPLIER_URL && parsed.FEED_SUPPLIER_TOKEN
        ? { baseURL: parsed.FEED_SUPPLIER_URL, token: parsed.FEED_SUPPLIER_TOKEN }
        : undefined,
    webListManagementConfig:
      parsed.FEED_SUPPLIER_URL && parsed.FEED_SUPPLIER_MANAGEMENT_TOKEN
        ? { baseURL: parsed.FEED_SUPPLIER_URL, token: parsed.FEED_SUPPLIER_MANAGEMENT_TOKEN }
        : undefined,
    host: parsed.HOST,
    metricsToken: parsed.METRICS_TOKEN,
    nodeEnvironment: parsed.NODE_ENV,
    port: parsed.PORT,
    processingMaxAttempts: parsed.PROCESSING_MAX_ATTEMPTS,
    processingMaxContentCharacters: parsed.PROCESSING_MAX_CONTENT_CHARS,
    processingRetryBaseDelayMs: parsed.PROCESSING_RETRY_BASE_DELAY_MS,
    processingWorkerPollIntervalMs: parsed.PROCESSING_WORKER_POLL_INTERVAL_MS,
    serverURL: parsed.SERVER_URL,
    trustProxy: parsed.TRUST_PROXY,
    uploadsDirectory: parsed.UPLOADS_DIRECTORY,
  }
}

export type ServerConfig = ReturnType<typeof loadServerConfig>
