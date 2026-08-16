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
  SERVER_URL: z.url().default("http://localhost:3000"),
})

export const loadServerConfig = (environment: NodeJS.ProcessEnv) => {
  const parsed = serverEnvironment.parse(environment)
  return {
    allowPrivateFeeds: parsed.ALLOW_PRIVATE_FEEDS,
    authSecret: parsed.BETTER_AUTH_SECRET,
    clientOrigins: parsed.CLIENT_ORIGINS,
    databaseURL: parsed.DATABASE_URL,
    feedFetchMaxBytes: parsed.FEED_FETCH_MAX_BYTES,
    feedFetchTimeoutMs: parsed.FEED_FETCH_TIMEOUT_MS,
    feedPollIntervalMs: parsed.FEED_POLL_INTERVAL_MS,
    host: parsed.HOST,
    port: parsed.PORT,
    serverURL: parsed.SERVER_URL,
  }
}

export type ServerConfig = ReturnType<typeof loadServerConfig>
