import { z } from "zod"

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

const supplierEnvironment = z
  .object({
    HOST: z.string().default("0.0.0.0"),
    INTERNAL_TOKEN: z.string().min(32),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: integer(3001, 1).pipe(z.number().max(65_535)),
    RSSHUB_ACCESS_KEY: z.string().min(16).optional(),
    RSSHUB_BASE_URL: upstreamURL.default("http://localhost:1200"),
    RSSHUB_FETCH_MAX_BYTES: integer(5 * 1024 * 1024, 1024),
    RSSHUB_FETCH_TIMEOUT_MS: integer(30_000, 1_000),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== "production") return

    if (!environment.RSSHUB_ACCESS_KEY) {
      context.addIssue({
        code: "custom",
        message: "Production requires RSSHUB_ACCESS_KEY",
        path: ["RSSHUB_ACCESS_KEY"],
      })
    }
    for (const key of ["INTERNAL_TOKEN", "RSSHUB_ACCESS_KEY"] as const) {
      const value = environment[key]
      if (value && /replace-with|development|example/i.test(value)) {
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
  })

export const loadFeedSupplierConfig = (environment: NodeJS.ProcessEnv) => {
  const parsed = supplierEnvironment.parse(environment)
  return {
    host: parsed.HOST,
    internalToken: parsed.INTERNAL_TOKEN,
    nodeEnvironment: parsed.NODE_ENV,
    port: parsed.PORT,
    rssHubAccessKey: parsed.RSSHUB_ACCESS_KEY,
    rssHubBaseURL: parsed.RSSHUB_BASE_URL,
    rssHubFetchMaxBytes: parsed.RSSHUB_FETCH_MAX_BYTES,
    rssHubFetchTimeoutMs: parsed.RSSHUB_FETCH_TIMEOUT_MS,
  }
}

export type FeedSupplierConfig = ReturnType<typeof loadFeedSupplierConfig>
