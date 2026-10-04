import { open, readFile } from "node:fs/promises"
import { parseArgs } from "node:util"

import { publishPublicFeeds } from "../src/public-feed-publish"
import { parseSubscriptionPreset } from "../src/subscription-export"
import { parseWebListPreset } from "../src/web-list-import"

const usage = `Usage: pnpm --filter @follow/feed-supplier sources:publish [options]

Publishes a subscription preset to one consumer grant and writes an OPML for a public reader.
Presets contain personal subscriptions and stay outside the repository.

Options:
  --grant <name>          Consumer grant name (required; case-insensitive)
  --create-grant          Create the grant if no active grant matches
  --allow-unresolved      Publish even when some preset entries cannot be resolved
  --subscriptions <file>  Subscription preset (required)
  --web-lists <file>      Web list preset (required)
  --out <file>            Output file (default: <grant-name>.opml)
  --revoke-missing        Revoke grant links absent from the preset
  --dry-run               Print the plan without changes or an OPML file
  --help                  Show this message

Environment:
  FEED_SUPPLIER_ADMIN_URL    Supplier base URL (default http://127.0.0.1:3001)
  FEED_SUPPLIER_ADMIN_TOKEN  Supplier ADMIN_TOKEN (required)`

const { values } = parseArgs({
  options: {
    "allow-unresolved": { default: false, type: "boolean" },
    "create-grant": { default: false, type: "boolean" },
    "dry-run": { default: false, type: "boolean" },
    grant: { type: "string" },
    help: { default: false, type: "boolean" },
    out: { type: "string" },
    "revoke-missing": { default: false, type: "boolean" },
    subscriptions: { type: "string" },
    "web-lists": { type: "string" },
  },
})
if (values.help) {
  console.info(usage)
  process.exit(0)
}
if (
  !values.grant ||
  !values.subscriptions ||
  !values["web-lists"] ||
  !process.env.FEED_SUPPLIER_ADMIN_TOKEN
) {
  console.error(usage)
  process.exit(2)
}

const grantName = values.grant
const filename =
  grantName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "grant"
const out = values.out ?? `${filename}.opml`
const result = await publishPublicFeeds({
  adminToken: process.env.FEED_SUPPLIER_ADMIN_TOKEN,
  allowUnresolved: values["allow-unresolved"],
  baseURL: process.env.FEED_SUPPLIER_ADMIN_URL ?? "http://127.0.0.1:3001",
  createGrant: values["create-grant"],
  dryRun: values["dry-run"],
  grantName,
  revokeMissing: values["revoke-missing"],
  subscriptions: parseSubscriptionPreset(await readFile(values.subscriptions, "utf8")),
  webLists: parseWebListPreset(await readFile(values["web-lists"], "utf8")),
})
if (result.opml !== null) {
  const file = await open(out, "w", 0o600)
  try {
    await file.chmod(0o600)
    await file.writeFile(result.opml)
  } finally {
    await file.close()
  }
  console.info(`Wrote ${out} with ${result.opml.match(/type="rss"/g)?.length ?? 0} subscriptions.`)
}
for (const line of result.lines) console.info(line)
if (result.unresolvedCount) process.exitCode = 1
