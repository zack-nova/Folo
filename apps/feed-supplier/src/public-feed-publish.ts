import type {
  CredentialUsageReport,
  IssuedPublicFeedLink,
  PublicFeedGrant,
  PublicFeedLink,
} from "@follow/feed-source-contracts"

import { SupplierAdminClient } from "./admin-client"
import type { ResolvedSubscription, SubscriptionPreset } from "./subscription-export"
import { renderSubscriptionOpml, resolveSubscriptions } from "./subscription-export"
import type { WebListPreset } from "./web-list-import"

export interface PublishOptions {
  adminToken: string
  baseURL: string
  createGrant?: boolean
  dryRun?: boolean
  fetchImplementation?: typeof fetch
  grantName: string
  revokeMissing?: boolean
  subscriptions: SubscriptionPreset
  webLists: WebListPreset
}

export interface PublishResult {
  lines: string[]
  opml: string | null
  unresolvedCount: number
}

const isNativeFeed = (url: string): boolean => {
  const protocol = new URL(url).protocol
  return protocol === "http:" || protocol === "https:"
}

/** Sync the preset to one grant and return a reader OPML without logging capability addresses. */
export const publishPublicFeeds = async (options: PublishOptions): Promise<PublishResult> => {
  const client = new SupplierAdminClient(
    options.baseURL,
    options.adminToken,
    options.fetchImplementation,
  )
  const { grants } = await client.request<{ grants: PublicFeedGrant[] }>(
    "GET",
    "v1/admin/public-feed-grants",
  )
  let grant = grants.find(
    (candidate) =>
      candidate.revokedAt === null &&
      candidate.name.toLowerCase() === options.grantName.toLowerCase(),
  )
  const lines: string[] = []
  if (!grant) {
    if (!options.createGrant) throw new Error(`No active grant named "${options.grantName}"`)
    if (options.dryRun) {
      lines.push(`Would create grant "${options.grantName}".`)
    } else {
      grant = (
        await client.request<{ grant: PublicFeedGrant }>("POST", "v1/admin/public-feed-grants", {
          name: options.grantName,
        })
      ).grant
      lines.push(`Created grant "${grant.name}".`)
    }
  }

  const { resolved, unresolved } = await resolveSubscriptions(
    options.subscriptions,
    options.webLists,
    {
      adminToken: options.adminToken,
      baseURL: options.baseURL,
      fetchImplementation: options.fetchImplementation,
    },
  )
  const metadataBySource = new Map<string, ResolvedSubscription>()
  for (const entry of resolved) {
    if (isNativeFeed(entry.url)) continue
    const previous = metadataBySource.get(entry.url)
    if (previous && (previous.title !== entry.title || previous.category !== entry.category)) {
      throw new Error("One supplier source has conflicting titles or categories in the preset")
    }
    metadataBySource.set(entry.url, entry)
  }
  const links = grant
    ? (
        await client.request<{ links: IssuedPublicFeedLink[] }>(
          "GET",
          `v1/admin/public-feed-grants/${encodeURIComponent(grant.id)}/export`,
        )
      ).links
    : []
  const linkBySource = new Map(links.map((link) => [link.sourceURL, link]))
  const expectedSources = new Set(
    resolved.filter((entry) => !isNativeFeed(entry.url)).map((entry) => entry.url),
  )
  const output: ResolvedSubscription[] = []
  let issued = 0
  let updated = 0
  let reused = 0
  let native = 0

  for (const subscription of resolved) {
    if (isNativeFeed(subscription.url)) {
      native++
      output.push(subscription)
      continue
    }
    let link = linkBySource.get(subscription.url)
    if (link) {
      if (link.title !== subscription.title || link.category !== subscription.category) {
        updated++
        if (options.dryRun)
          lines.push(`Would update: ${subscription.category} / ${subscription.title}`)
        if (!options.dryRun && grant) {
          await client.request<{ link: PublicFeedLink }>(
            "PATCH",
            `v1/admin/public-feed-grants/${encodeURIComponent(grant.id)}/links/${encodeURIComponent(link.id)}`,
            { title: subscription.title, category: subscription.category },
          )
          link = { ...link, title: subscription.title, category: subscription.category }
          linkBySource.set(subscription.url, link)
        }
      } else {
        reused++
      }
    } else {
      issued++
      if (options.dryRun)
        lines.push(`Would issue: ${subscription.category} / ${subscription.title}`)
      if (!options.dryRun && grant) {
        link = (
          await client.request<{ link: IssuedPublicFeedLink }>(
            "POST",
            `v1/admin/public-feed-grants/${encodeURIComponent(grant.id)}/links`,
            {
              sourceURL: subscription.url,
              title: subscription.title,
              category: subscription.category,
            },
          )
        ).link
        linkBySource.set(subscription.url, link)
      }
    }
    if (link) output.push({ ...subscription, url: link.url })
  }

  const missing = links.filter((link) => !expectedSources.has(link.sourceURL))
  if (options.revokeMissing && !options.dryRun && grant) {
    for (const link of missing) {
      await client.request<void>(
        "DELETE",
        `v1/admin/public-feed-grants/${encodeURIComponent(grant.id)}/links/${encodeURIComponent(link.id)}`,
      )
    }
  }
  lines.push(
    `${options.dryRun ? "Plan" : "Published"}: ${native} native, ${issued} new, ${updated} updated, ${reused} unchanged; ${missing.length} missing${options.revokeMissing ? " to revoke" : " retained"}.`,
  )
  for (const link of missing) {
    lines.push(
      `${options.revokeMissing ? "Revoke" : "Missing from preset"}: ${link.category ?? "Uncategorized"} / ${link.title ?? "Untitled"}`,
    )
  }
  for (const entry of [...unresolved, ...options.subscriptions.skipped]) {
    lines.push(`Left out ${entry.key}: ${entry.reason}`)
  }

  if (grant) {
    const usage = await client.request<CredentialUsageReport>(
      "GET",
      `v1/admin/credential-usage?grantId=${encodeURIComponent(grant.id)}`,
    )
    const groups = new Map<string, string[]>()
    for (const entry of usage.links) {
      if (entry.dependency.status === "none") continue
      const details =
        entry.dependency.status === "unknown"
          ? "unknown"
          : `uses ${[
              ...entry.dependency.boundCredentials,
              ...entry.dependency.rssHubCredentials.map(
                (credential) => `${credential.name}${credential.required ? " (required)" : ""}`,
              ),
            ].join(", ")}`
      const category = entry.category ?? "Uncategorized"
      groups.set(category, [
        ...(groups.get(category) ?? []),
        `  ${entry.title ?? "Untitled"}: ${details}`,
      ])
    }
    lines.push("Credential usage:")
    if (groups.size === 0) lines.push("  No uses or unknown dependencies.")
    for (const [category, entries] of groups) lines.push(`  ${category}:`, ...entries)
  }

  return {
    lines,
    opml: options.dryRun ? null : renderSubscriptionOpml(output, grant?.name ?? options.grantName),
    unresolvedCount: unresolved.length,
  }
}
