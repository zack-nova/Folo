import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"

import { importCatalogPreset, parseCatalogPreset } from "../src/catalog-import"

const usage = `Usage: pnpm --filter @follow/feed-supplier sources:import:catalog [options] [preset.json]

Without --apply nothing is written: the preset is validated and compared with the supplier.

Options:
  --apply        Create missing catalog routes (disabled)
  --enable       With --apply, enable each disabled route, test it with its sample parameters
                 and disable it again when the test fails
  --only <keys>  Comma-separated route keys to import
  --help         Show this message

Environment:
  FEED_SUPPLIER_ADMIN_URL    Supplier base URL (default http://127.0.0.1:3001)
  FEED_SUPPLIER_ADMIN_TOKEN  Supplier ADMIN_TOKEN (required)`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    apply: { default: false, type: "boolean" },
    enable: { default: false, type: "boolean" },
    help: { default: false, type: "boolean" },
    only: { type: "string" },
  },
})

if (values.help) {
  console.info(usage)
  process.exit(0)
}
if (values.enable && !values.apply) {
  console.error("--enable requires --apply")
  process.exit(2)
}
const adminToken = process.env.FEED_SUPPLIER_ADMIN_TOKEN
if (!adminToken) {
  console.error("FEED_SUPPLIER_ADMIN_TOKEN is required")
  process.exit(2)
}

const presetPath =
  positionals[0] ?? new URL("../presets/rsshub-catalog.json", import.meta.url).pathname
const entries = await parseCatalogPreset(await readFile(presetPath, "utf8"))
const results = await importCatalogPreset(entries, {
  adminToken,
  apply: values.apply,
  baseURL: process.env.FEED_SUPPLIER_ADMIN_URL ?? "http://127.0.0.1:3001",
  enable: values.enable,
  only: values.only ? new Set(values.only.split(",").map((key) => key.trim())) : undefined,
})

console.table(
  results.map((result) => ({
    key: result.key,
    status: result.status,
    bytes: result.contentBytes ?? "",
    detail: result.logicalURL ?? result.message?.slice(0, 70) ?? "",
  })),
)
const failed = results.filter((result) => result.status === "test_failed")
if (!values.apply) console.info("Dry run: rerun with --apply to create the planned routes.")
if (failed.length) {
  console.warn(
    `${failed.length} route(s) failed their test and stay disabled; see the README for the RSSHub settings they need.`,
  )
  process.exitCode = 1
}
