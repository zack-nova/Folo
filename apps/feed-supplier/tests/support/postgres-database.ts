import { randomUUID } from "node:crypto"

import { Pool } from "pg"

/**
 * A fresh database next to the one in TEST_FEED_SUPPLIER_DATABASE_URL, so a test file cannot see
 * rows another file left behind. Key rotation, for example, re-encrypts every credential and link
 * in the database it runs against.
 */
export const isolatedDatabaseURL = async (baseURL: string, label: string): Promise<string> => {
  const name = `supplier_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  const pool = new Pool({ connectionString: baseURL, max: 1 })
  try {
    await pool.query(`create database ${name}`)
  } finally {
    await pool.end()
  }
  const url = new URL(baseURL)
  url.pathname = `/${name}`
  return url.toString()
}
