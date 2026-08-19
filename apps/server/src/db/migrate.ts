import { fileURLToPath } from "node:url"

import { getMigrations } from "better-auth/db/migration"
import { eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/node-postgres/migrator"

import type { AppAuth } from "../auth"
import type { ApplicationDatabase } from "./database"
import { instanceMetadata } from "./schema"

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url))
export const DATABASE_SCHEMA_VERSION = 4

export const assertSupportedSchemaVersion = (
  storedVersion: string | null,
  supportedVersion = DATABASE_SCHEMA_VERSION,
) => {
  if (storedVersion === null) return
  const parsed = Number(storedVersion)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Database schema version is invalid: ${storedVersion}`)
  }
  if (parsed > supportedVersion) {
    throw new Error(
      `Database schema version ${parsed} is newer than supported version ${supportedVersion}`,
    )
  }
}

const assertDatabaseCompatible = async (database: ApplicationDatabase) => {
  const relation = await database.execute<{ relation: string | null }>(
    sql`select to_regclass('public.instance_metadata')::text as relation`,
  )
  if (!relation.rows[0]?.relation) return
  const stored = await database
    .select({ value: instanceMetadata.value })
    .from(instanceMetadata)
    .where(eq(instanceMetadata.key, "schema_version"))
    .limit(1)
  assertSupportedSchemaVersion(stored[0]?.value ?? null)
}

export const migrateDatabase = async ({
  auth,
  database,
}: {
  auth: AppAuth
  database: ApplicationDatabase
}) => {
  await assertDatabaseCompatible(database)
  const authMigrations = await getMigrations(auth.options)
  await authMigrations.runMigrations()
  await migrate(database, { migrationsFolder })
  await database
    .insert(instanceMetadata)
    .values({
      key: "schema_version",
      updatedAt: new Date(),
      value: String(DATABASE_SCHEMA_VERSION),
    })
    .onConflictDoUpdate({
      target: instanceMetadata.key,
      set: { updatedAt: new Date(), value: String(DATABASE_SCHEMA_VERSION) },
    })
}
