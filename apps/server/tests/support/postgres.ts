import { randomUUID } from "node:crypto"

import { Pool } from "pg"

import { createAuth } from "../../src/auth"
import { createPostgresDatabase } from "../../src/db/database"
import { migrateDatabase } from "../../src/db/migrate"

export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>

/**
 * Postgres-backed tests migrate a database and make many round trips. They take a second or two
 * alone, but the default 5s runs out while the whole suite saturates the CPU.
 */
export const POSTGRES_TEST_TIMEOUT_MS = 30_000

/**
 * Creates and migrates a throwaway database on the server `TEST_DATABASE_URL` names. Test files
 * run in parallel, and a shared database lets them race each other's migrations, sync log cleanup
 * and processing queue, so each file gets its own.
 */
export const createTestDatabase = async (serverURL: string) => {
  // Only hex digits, so the name is safe to splice into the statements below.
  const name = `folo_test_${randomUUID().replaceAll("-", "")}`
  const admin = new Pool({ connectionString: serverURL, max: 1 })
  await admin.query(`create database "${name}"`)

  const url = new URL(serverURL)
  url.pathname = `/${name}`
  const database = createPostgresDatabase(url.toString())
  const drop = async () => {
    await database.pool.end()
    try {
      // No `with (force)`: the pool resolves before its sockets finish closing, and terminating
      // those backends would surface as an uncaught error. A plain drop waits for them to exit.
      await admin.query(`drop database if exists "${name}"`)
    } finally {
      await admin.end()
    }
  }

  try {
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: database.pool,
      secret: "test-database-migration-secret-of-32-characters",
      trustedOrigins: [],
    })
    await migrateDatabase({ auth, database: database.db })
  } catch (error) {
    await drop()
    throw error
  }
  return { ...database, drop }
}
