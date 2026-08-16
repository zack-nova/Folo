import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import * as schema from "./schema"

export type ApplicationDatabase = NodePgDatabase<typeof schema>

export const createPostgresDatabase = (databaseURL: string) => {
  const pool = new Pool({ connectionString: databaseURL })
  const db = drizzle({ client: pool, schema })
  return { db, pool }
}
