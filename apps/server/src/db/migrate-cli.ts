import { createAuth } from "../auth"
import { loadServerConfig } from "../config"
import { createPostgresDatabase } from "./database"
import { migrateDatabase } from "./migrate"

const config = loadServerConfig(process.env)
const database = createPostgresDatabase(config.databaseURL)
const auth = createAuth({
  baseURL: config.serverURL,
  database: database.pool,
  secret: config.authSecret,
  trustedOrigins: config.clientOrigins,
})

try {
  await migrateDatabase({ auth, database: database.db })
} finally {
  await database.pool.end()
}
