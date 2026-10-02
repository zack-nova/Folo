import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"

import {
  parseSubscriptionPreset,
  renderSubscriptionOpml,
  resolveSubscriptions,
} from "../src/subscription-export"
import { parseWebListPreset } from "../src/web-list-import"

const usage = `Usage: pnpm --filter @follow/feed-supplier sources:export:opml [options]

Writes the Feeds Agent subscriptions as an OPML file for Folo's OPML import. Web list entries
are resolved to their weblist:// address on the supplier; import the web list preset first.

Options:
  --out <file>   Output file (default: feeds-agent-subscriptions.opml)
  --help         Show this message

Environment:
  FEED_SUPPLIER_ADMIN_URL    Supplier base URL (default http://127.0.0.1:3001)
  FEED_SUPPLIER_ADMIN_TOKEN  Supplier ADMIN_TOKEN; without it web list entries are left out`

const { values } = parseArgs({
  options: {
    help: { default: false, type: "boolean" },
    out: { default: "feeds-agent-subscriptions.opml", type: "string" },
  },
})
if (values.help) {
  console.info(usage)
  process.exit(0)
}

const preset = (name: string) => readFile(new URL(`../presets/${name}`, import.meta.url), "utf8")
const subscriptions = parseSubscriptionPreset(await preset("feeds-agent-subscriptions.json"))
const webLists = parseWebListPreset(await preset("feeds-agent-web-lists.json"))
const adminToken = process.env.FEED_SUPPLIER_ADMIN_TOKEN
const { resolved, unresolved } = await resolveSubscriptions(
  subscriptions,
  webLists,
  adminToken
    ? { adminToken, baseURL: process.env.FEED_SUPPLIER_ADMIN_URL ?? "http://127.0.0.1:3001" }
    : null,
)

await writeFile(values.out, renderSubscriptionOpml(resolved, "Feeds Agent subscriptions"))
console.info(`Wrote ${resolved.length} subscriptions to ${values.out}.`)
for (const { key, reason } of [...unresolved, ...subscriptions.skipped]) {
  console.warn(`Left out ${key}: ${reason}`)
}
if (unresolved.length) process.exitCode = 1
