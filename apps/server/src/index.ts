import { createAuth } from "./auth"
import { loadServerConfig } from "./config"
import { PostgresDataStore } from "./data/postgres-store"
import { createPostgresDatabase } from "./db/database"
import { migrateDatabase } from "./db/migrate"
import { HttpFeedFetcher } from "./feeds/http-fetcher"
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
const feedFetcher = new HttpFeedFetcher({
  allowPrivateAddresses: config.allowPrivateFeeds,
  maxBytes: config.feedFetchMaxBytes,
  timeoutMs: config.feedFetchTimeoutMs,
})
const server = await buildServer({
  aiEncryptionSecret: config.aiEncryptionSecret,
  aiProviderConfig: config.aiProviderConfig,
  allowPublicRegistration: config.allowPublicRegistration,
  auth,
  clientOrigins: config.clientOrigins,
  dataStore,
  feedFetcher,
  feedPollIntervalMs: config.feedPollIntervalMs,
  logger: true,
  processingMaxAttempts: config.processingMaxAttempts,
  processingRetryBaseDelayMs: config.processingRetryBaseDelayMs,
  processingWorkerPollIntervalMs: config.processingWorkerPollIntervalMs,
  serverURL: config.serverURL,
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
