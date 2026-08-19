import { createAuth } from "./auth"
import { loadServerConfig } from "./config"
import { PostgresDataStore } from "./data/postgres-store"
import { createPostgresDatabase } from "./db/database"
import { migrateDatabase } from "./db/migrate"
import { FeedSupplierFetcher } from "./feeds/feed-supplier-fetcher"
import { HttpFeedFetcher } from "./feeds/http-fetcher"
import { RoutingFeedFetcher } from "./feeds/routing-fetcher"
import { buildServer } from "./server"

const config = loadServerConfig(process.env)
const database = createPostgresDatabase(config.databaseURL)
const auth = createAuth({
  baseURL: config.serverURL,
  database: database.pool,
  secret: config.authSecret,
  trustedOrigins: config.clientOrigins,
})

await migrateDatabase({ auth, database: database.db })

const dataStore = new PostgresDataStore(database.db)
const standardFeedFetcher = new HttpFeedFetcher({
  allowPrivateAddresses: config.allowPrivateFeeds,
  maxBytes: config.feedFetchMaxBytes,
  timeoutMs: config.feedFetchTimeoutMs,
})
const feedSupplierFetcher = config.feedSupplierConfig
  ? new FeedSupplierFetcher({
      ...config.feedSupplierConfig,
      maxBytes: config.feedFetchMaxBytes,
      timeoutMs: config.feedFetchTimeoutMs,
    })
  : null
const feedFetcher = feedSupplierFetcher
  ? new RoutingFeedFetcher(standardFeedFetcher, feedSupplierFetcher)
  : standardFeedFetcher
const server = await buildServer({
  aiEncryptionSecret: config.aiEncryptionSecret,
  aiProviderConfig: config.aiProviderConfig,
  apiRateLimitMax: config.apiRateLimitMax,
  allowPublicRegistration: config.allowPublicRegistration,
  auth,
  authRateLimitMax: config.authRateLimitMax,
  clientOrigins: config.clientOrigins,
  dataStore,
  feedFetcher,
  feedPollConcurrency: config.feedPollConcurrency,
  feedPollIntervalMs: config.feedPollIntervalMs,
  feedRetryBaseDelayMs: config.feedRetryBaseDelayMs,
  logger: true,
  metricsToken: config.metricsToken,
  processingMaxAttempts: config.processingMaxAttempts,
  processingRetryBaseDelayMs: config.processingRetryBaseDelayMs,
  processingWorkerPollIntervalMs: config.processingWorkerPollIntervalMs,
  readabilityFetcher: standardFeedFetcher,
  serverURL: config.serverURL,
  sourceCatalogClient: feedSupplierFetcher ?? undefined,
  trustProxyHops: config.trustProxyHops,
  uploadsDirectory: config.uploadsDirectory,
})

await server.listen({ host: config.host, port: config.port })

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  await server.close()
  await database.pool.end()
}

process.once("SIGINT", () => void shutdown())
process.once("SIGTERM", () => void shutdown())
