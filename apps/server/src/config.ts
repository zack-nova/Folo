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

const serverEnvironment = z.object({
  AI_API_KEY: z.string().min(1).optional(),
  AI_ENCRYPTION_SECRET: z.string().min(32).optional(),
  AI_PROVIDER_BASE_URL: z.url().default("https://api.openai.com/v1"),
  AI_PROVIDER_MODEL: z.string().min(1).default("gpt-4o-mini"),
  AI_PROVIDER_TIMEOUT_MS: integer(60_000, 1_000),
  ALLOW_PUBLIC_REGISTRATION: boolean,
  ALLOW_PRIVATE_FEEDS: boolean,
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
  HOST: z.string().default("0.0.0.0"),
  PORT: integer(3000, 1).pipe(z.number().max(65_535)),
  PROCESSING_MAX_ATTEMPTS: integer(3, 1).pipe(z.number().max(10)),
  PROCESSING_RETRY_BASE_DELAY_MS: integer(1_000, 1),
  PROCESSING_WORKER_POLL_INTERVAL_MS: integer(1_000, 10),
  SERVER_URL: z.url().default("http://localhost:3000"),
  UPLOADS_DIRECTORY: z.string().min(1).default("./data/uploads"),
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
    allowPublicRegistration: parsed.ALLOW_PUBLIC_REGISTRATION,
    allowPrivateFeeds: parsed.ALLOW_PRIVATE_FEEDS,
    authSecret: parsed.BETTER_AUTH_SECRET,
    clientOrigins: parsed.CLIENT_ORIGINS,
    databaseURL: parsed.DATABASE_URL,
    feedFetchMaxBytes: parsed.FEED_FETCH_MAX_BYTES,
    feedFetchTimeoutMs: parsed.FEED_FETCH_TIMEOUT_MS,
    feedPollIntervalMs: parsed.FEED_POLL_INTERVAL_MS,
    host: parsed.HOST,
    port: parsed.PORT,
    processingMaxAttempts: parsed.PROCESSING_MAX_ATTEMPTS,
    processingRetryBaseDelayMs: parsed.PROCESSING_RETRY_BASE_DELAY_MS,
    processingWorkerPollIntervalMs: parsed.PROCESSING_WORKER_POLL_INTERVAL_MS,
    serverURL: parsed.SERVER_URL,
    uploadsDirectory: parsed.UPLOADS_DIRECTORY,
  }
}

export type ServerConfig = ReturnType<typeof loadServerConfig>
