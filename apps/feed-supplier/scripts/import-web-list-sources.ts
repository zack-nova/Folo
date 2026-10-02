import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"

import { importWebListPreset, parseWebListPreset } from "../src/web-list-import"

const usage = `Usage: pnpm --filter @follow/feed-supplier sources:import:web-lists [options] [preset.json]

Without --apply nothing is written: the preset is validated and compared with the supplier.

Options:
  --apply        Create missing sources (disabled) and run a detail preview for each one
  --enable       With --apply, enable sources whose preview extracted at least one item
  --only <keys>  Comma-separated preset keys to import
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
  positionals[0] ?? new URL("../presets/feeds-agent-web-lists.json", import.meta.url).pathname
const preset = parseWebListPreset(await readFile(presetPath, "utf8"))
const results = await importWebListPreset(preset, {
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
    items: result.itemCount ?? "",
    detail: result.detailStatus ?? "",
    first: result.firstTitle?.slice(0, 40) ?? result.message?.slice(0, 60) ?? "",
    feedURL: result.feedURL ?? "",
  })),
)
const failed = results.filter(
  (result) =>
    result.status === "detail_failed" ||
    result.status === "test_failed" ||
    result.status === "test_empty",
)
if (!values.apply) console.info("Dry run: rerun with --apply to create the planned sources.")
if (failed.length) {
  console.warn(`${failed.length} source(s) need attention and were left disabled.`)
  process.exitCode = 1
}
