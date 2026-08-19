import { describe, expect, it } from "vitest"

import { assertSupportedSchemaVersion, DATABASE_SCHEMA_VERSION } from "../src/db/migrate"

describe("database version compatibility", () => {
  it("accepts an unversioned or current database and rejects a future schema", () => {
    expect(() => assertSupportedSchemaVersion(null)).not.toThrow()
    expect(() => assertSupportedSchemaVersion(String(DATABASE_SCHEMA_VERSION))).not.toThrow()
    expect(() => assertSupportedSchemaVersion(String(DATABASE_SCHEMA_VERSION + 1))).toThrow(
      "is newer than supported version",
    )
    expect(() => assertSupportedSchemaVersion("invalid")).toThrow("is invalid")
  })
})
