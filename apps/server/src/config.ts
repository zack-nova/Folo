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

const serverEnvironment = z
  .object({
    AI_API_KEY: z.string().min(1).optional(),
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
    HOST: z.string().default("0.0.0.0"),
    METRICS_TOKEN: z.string().min(32).optional(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: integer(3000, 1).pipe(z.number().max(65_535)),
    PROCESSING_MAX_ATTEMPTS: integer(3, 1).pipe(z.number().max(10)),
    PROCESSING_RETRY_BASE_DELAY_MS: integer(1_000, 1),
    PROCESSING_WORKER_POLL_INTERVAL_MS: integer(1_000, 10),
    SERVER_URL: z.url().default("http://localhost:3000"),
    TRUST_PROXY_HOPS: integer(0, 0).pipe(z.number().max(8)),
    UPLOADS_DIRECTORY: z.string().min(1).default("./data/uploads"),
  })
  .superRefine((environment, context) => {
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
  })

export const loadServerConfig = (environment: NodeJS.ProcessEnv) => {
  const parsed = serverEnvironment.parse(environment)
  return {
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
    host: parsed.HOST,
    metricsToken: parsed.METRICS_TOKEN,
    nodeEnvironment: parsed.NODE_ENV,
    port: parsed.PORT,
    processingMaxAttempts: parsed.PROCESSING_MAX_ATTEMPTS,
    processingRetryBaseDelayMs: parsed.PROCESSING_RETRY_BASE_DELAY_MS,
    processingWorkerPollIntervalMs: parsed.PROCESSING_WORKER_POLL_INTERVAL_MS,
    serverURL: parsed.SERVER_URL,
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    uploadsDirectory: parsed.UPLOADS_DIRECTORY,
  }
}

export type ServerConfig = ReturnType<typeof loadServerConfig>
