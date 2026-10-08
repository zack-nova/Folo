import { text } from "node:stream/consumers"

import type {
  OfficialAccountSummary,
  OfficialAcquisitionBinding,
  OfficialSubscriptionSummary,
} from "@follow/feed-source-contracts"

import { SupplierAdminClient } from "../src/admin-client"

const usage = `Usage: pnpm --filter @follow/feed-supplier sources:official <command>

Manages the official Folo account used for official acquisition (ADR-0034). The supplier must
run with FOLO_OFFICIAL_API_URL set.

Commands:
  link     Link an account. Reads the official session token from standard input, never from
           an argument, e.g. after signing in with the official CLI:
             jq -r .token ~/.folo/config.json | pnpm ... sources:official link
           Linking replaces any account linked before.
  status   Show the linked account
  verify   Check the session again and refresh the plan and limits
  unlink   Unlink the account

  subscriptions        List the rsshub:// subscriptions of the official account and whether
                       each is bound (read-only)
  bindings             List bindings
  bind <rsshub://...>  Fetch this source through the official account. The account must already
                       subscribe to it; the supplier never subscribes on your behalf.
  retry <binding-id>   Try again to adopt a failed binding
  unbind <binding-id>  Stop fetching through the official account; the self-hosted RSSHub
                       serves the address again. The official subscription is left as is.

Environment:
  FEED_SUPPLIER_ADMIN_URL    Supplier base URL (default http://127.0.0.1:3001)
  FEED_SUPPLIER_ADMIN_TOKEN  Supplier ADMIN_TOKEN (required)`

const command = process.argv[2]
const commands = [
  "link",
  "status",
  "verify",
  "unlink",
  "subscriptions",
  "bindings",
  "bind",
  "retry",
  "unbind",
]
if (!command || command === "--help" || !commands.includes(command)) {
  console.info(usage)
  process.exit(command && command !== "--help" ? 2 : 0)
}
const adminToken = process.env.FEED_SUPPLIER_ADMIN_TOKEN
if (!adminToken) {
  console.error("FEED_SUPPLIER_ADMIN_TOKEN is required")
  process.exit(2)
}
const client = new SupplierAdminClient(
  process.env.FEED_SUPPLIER_ADMIN_URL ?? "http://127.0.0.1:3001",
  adminToken,
)
const path = "v1/admin/official/account"
const bindingsPath = "v1/admin/official/bindings"
const argument = process.argv[3]

const describeBinding = (binding: OfficialAcquisitionBinding) =>
  [
    `${binding.status.padEnd(8)} ${binding.sourceURL}`,
    `         id ${binding.id}${
      binding.externalFeedId ? ` | official feed ${binding.externalFeedId}` : ""
    }${binding.origin ? ` | ${binding.origin}` : ""}`,
    ...(binding.lastErrorCode
      ? [`         last error ${binding.lastErrorCode}: ${binding.lastErrorSummary ?? ""}`]
      : []),
  ].join("\n")

const describe = (account: OfficialAccountSummary | null) => {
  if (!account) return "No official account is linked."
  return [
    `Status:              ${account.status}`,
    `Official user ID:    ${account.externalUserId}`,
    `Plan:                ${account.role ?? "unknown"}`,
    `RSSHub limit:        ${account.rssHubSubscriptionLimit ?? "unknown"}`,
    `Feed limit:          ${account.feedSubscriptionLimit ?? "unknown"}`,
    `Linked at:           ${account.linkedAt}`,
    `Last verified at:    ${account.lastVerifiedAt}`,
    `Session expires at:  ${account.sessionExpiresAt ?? "unknown"}`,
    ...(account.authInvalidAt ? [`Rejected at:         ${account.authInvalidAt}`] : []),
  ].join("\n")
}

try {
  if (command === "link") {
    if (process.stdin.isTTY) {
      console.error("Pipe the token on standard input; it is never accepted as an argument.")
      process.exit(2)
    }
    const token = (await text(process.stdin)).trim()
    const { account } = await client.request<{ account: OfficialAccountSummary }>("POST", path, {
      token,
    })
    console.info(`Linked.\n${describe(account)}`)
  } else if (command === "status") {
    const { account } = await client.request<{ account: OfficialAccountSummary | null }>(
      "GET",
      path,
    )
    console.info(describe(account))
  } else if (command === "verify") {
    const { account } = await client.request<{ account: OfficialAccountSummary }>(
      "POST",
      `${path}/verify`,
    )
    console.info(describe(account))
    if (account.status !== "active") process.exitCode = 1
  } else if (command === "unlink") {
    await client.request("DELETE", path)
    console.info("Unlinked.")
  } else if (command === "subscriptions") {
    const { subscriptions } = await client.request<{
      subscriptions: OfficialSubscriptionSummary[]
    }>("GET", "v1/admin/official/subscriptions")
    for (const item of subscriptions) {
      console.info(
        `${item.bound ? "bound  " : "       "} ${item.sourceURL}  ${item.title ?? ""}` +
          `${item.category ? `  [${item.category}]` : ""}${item.isPrivate ? "  (private)" : ""}`,
      )
    }
    console.info(`${subscriptions.length} rsshub:// subscriptions in the official account.`)
  } else if (command === "bindings") {
    const { bindings } = await client.request<{ bindings: OfficialAcquisitionBinding[] }>(
      "GET",
      bindingsPath,
    )
    for (const binding of bindings) console.info(describeBinding(binding))
    console.info(`${bindings.length} bindings.`)
  } else if (command === "bind") {
    if (!argument) {
      console.error("bind needs an rsshub:// address")
      process.exit(2)
    }
    const { binding } = await client.request<{ binding: OfficialAcquisitionBinding }>(
      "POST",
      bindingsPath,
      { sourceURL: argument },
    )
    console.info(describeBinding(binding))
    if (binding.status !== "active") process.exitCode = 1
  } else if (command === "retry") {
    if (!argument) {
      console.error("retry needs a binding id")
      process.exit(2)
    }
    const { binding } = await client.request<{ binding: OfficialAcquisitionBinding }>(
      "POST",
      `${bindingsPath}/${encodeURIComponent(argument)}/retry`,
    )
    console.info(describeBinding(binding))
    if (binding.status !== "active") process.exitCode = 1
  } else {
    if (!argument) {
      console.error("unbind needs a binding id")
      process.exit(2)
    }
    await client.request("DELETE", `${bindingsPath}/${encodeURIComponent(argument)}`)
    console.info("Unbound; the self-hosted RSSHub serves the address again.")
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
