import { fileURLToPath } from "node:url"

import { getMigrations } from "better-auth/db/migration"
import { migrate } from "drizzle-orm/node-postgres/migrator"

import type { AppAuth } from "../auth"
import type { ApplicationDatabase } from "./database"

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url))

export const migrateDatabase = async ({
  auth,
  database,
}: {
  auth: AppAuth
  database: ApplicationDatabase
}) => {
  const authMigrations = await getMigrations(auth.options)
  await authMigrations.runMigrations()
  await migrate(database, { migrationsFolder })
}
