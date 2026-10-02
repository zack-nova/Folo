import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"

import { PostgresDataStore } from "./data/postgres-store"
import { createPostgresDatabase } from "./db/database"
import { importAIPreset, parseAIPreset } from "./processing/ai-preset"

const usage = `Usage: pnpm --filter @follow/server ai:import-preset [options] [preset.json]

Imports a processing taxonomy, evaluate action rules and (optionally) a profile document into
the instance owner's account. Without --apply nothing is written.

Options:
  --profile <file>  Markdown profile document to store as the profile snapshot. Profiles are
                    personal: keep the file outside the repository.
  --apply           Write the snapshots and add missing action rules
  --help            Show this message

Environment:
  DATABASE_URL      The Folo server database`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    apply: { default: false, type: "boolean" },
    help: { default: false, type: "boolean" },
    profile: { type: "string" },
  },
})
if (values.help) {
  console.info(usage)
  process.exit(0)
}
const databaseURL = process.env.DATABASE_URL
if (!databaseURL) {
  console.error("DATABASE_URL is required")
  process.exit(2)
}

const preset = parseAIPreset(
  await readFile(
    positionals[0] ?? new URL("../presets/feeds-agent-ai.json", import.meta.url).pathname,
    "utf8",
  ),
)
const profileDocument = values.profile ? (await readFile(values.profile, "utf8")).trim() : null
if (profileDocument === "") {
  console.error("The profile document is empty; nothing was imported.")
  process.exit(2)
}
const database = createPostgresDatabase(databaseURL)
try {
  const dataStore = new PostgresDataStore(database.db)
  const ownerUserId = await dataStore.getOwnerUserId()
  if (!ownerUserId) {
    console.error("The instance has no owner yet; sign in once before importing.")
    process.exitCode = 1
  } else {
    const report = await importAIPreset(dataStore, ownerUserId, preset, {
      apply: values.apply,
      profileDocument,
    })
    console.table([
      { item: `profile "${preset.profile.name}"`, ...report.profile },
      { item: `taxonomy "${preset.taxonomy.name}"`, ...report.taxonomy },
      ...report.actionRules.map((rule) => ({ item: `rule "${rule.name}"`, status: rule.status })),
    ])
    if (!profileDocument) console.info("No --profile given: the profile snapshot was left alone.")
    if (!values.apply) console.info("Dry run: rerun with --apply to write these changes.")
  }
} catch (error) {
  // Database errors embed query parameters, which include the personal profile document;
  // report only the error class and code.
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : "unknown"
  console.error(`Import failed (${error instanceof Error ? error.name : "Error"}, code ${code}).`)
  process.exitCode = 1
} finally {
  await database.pool.end()
}
