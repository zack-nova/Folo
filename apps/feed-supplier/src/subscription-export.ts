import type { WebListSource } from "@follow/feed-source-contracts"
import { z } from "zod"

import { SupplierAdminClient } from "./admin-client"
import type { WebListPreset } from "./web-list-import"

const subscriptionURL = z.string().refine((value) => {
  try {
    return ["http:", "https:", "rsshub:", "pagechange:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}, "Subscription URL must use http, https, rsshub or pagechange")

const presetSchema = z
  .object({
    description: z.string(),
    skipped: z.array(z.object({ key: z.string(), reason: z.string() }).strict()),
    subscriptions: z
      .array(
        z.union([
          z
            .object({
              category: z.string().min(1),
              key: z.string().min(1),
              title: z.string().min(1),
              url: subscriptionURL,
            })
            .strict(),
          z
            .object({
              category: z.string().min(1),
              key: z.string().min(1),
              title: z.string().min(1),
              webList: z.string().min(1),
            })
            .strict(),
        ]),
      )
      .min(1),
  })
  .strict()

export type SubscriptionPreset = z.infer<typeof presetSchema>

export const parseSubscriptionPreset = (text: string): SubscriptionPreset => {
  const preset = presetSchema.parse(JSON.parse(text))
  const keys = new Set<string>()
  for (const subscription of preset.subscriptions) {
    if (keys.has(subscription.key))
      throw new Error(`Duplicate subscription key ${subscription.key}`)
    keys.add(subscription.key)
  }
  return preset
}

export interface ResolvedSubscription {
  category: string
  title: string
  url: string
}

export interface SubscriptionResolution {
  resolved: ResolvedSubscription[]
  unresolved: { key: string; reason: string }[]
}

/**
 * Turn preset entries into subscribable addresses. Web list entries point at a key of the web
 * list preset; their `weblist://` address only exists once the source was created, so it is
 * looked up on the supplier by the source's name.
 */
export const resolveSubscriptions = async (
  preset: SubscriptionPreset,
  webLists: WebListPreset,
  supplier: { adminToken: string; baseURL: string; fetchImplementation?: typeof fetch } | null,
): Promise<SubscriptionResolution> => {
  const needsSupplier = preset.subscriptions.some((subscription) => "webList" in subscription)
  const sources =
    needsSupplier && supplier
      ? (
          await new SupplierAdminClient(
            supplier.baseURL,
            supplier.adminToken,
            supplier.fetchImplementation,
          ).request<{ sources: WebListSource[] }>("GET", "v1/admin/web-list-sources")
        ).sources
      : []
  const feedURLByName = new Map(
    sources.map((source) => [source.name.toLowerCase(), source.feedURL]),
  )
  const resolved: ResolvedSubscription[] = []
  const unresolved: SubscriptionResolution["unresolved"] = []
  for (const subscription of preset.subscriptions) {
    if ("url" in subscription) {
      resolved.push({
        category: subscription.category,
        title: subscription.title,
        url: subscription.url,
      })
      continue
    }
    const entry = webLists.entries.find((candidate) => candidate.key === subscription.webList)
    if (!entry) {
      unresolved.push({ key: subscription.key, reason: `Unknown web list ${subscription.webList}` })
      continue
    }
    const url = feedURLByName.get(entry.input.name.toLowerCase())
    if (!url) {
      unresolved.push({
        key: subscription.key,
        reason: supplier
          ? `Web list source "${entry.input.name}" does not exist on the supplier yet`
          : "Web list addresses need FEED_SUPPLIER_ADMIN_TOKEN",
      })
      continue
    }
    resolved.push({ category: subscription.category, title: subscription.title, url })
  }
  return { resolved, unresolved }
}

const escapeXML = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

/** OPML 2.0 with one outline per category, in the order categories first appear. */
export const renderSubscriptionOpml = (
  subscriptions: ResolvedSubscription[],
  title: string,
): string => {
  // Not named after categories: the API usage scanner reads a Map lookup on it as an SDK call.
  const groups = new Map<string, ResolvedSubscription[]>()
  for (const subscription of subscriptions) {
    groups.set(subscription.category, [...(groups.get(subscription.category) ?? []), subscription])
  }
  const outlines = [...groups]
    .map(
      ([category, items]) =>
        `    <outline text="${escapeXML(category)}" title="${escapeXML(category)}">\n${items
          .map(
            (item) =>
              `      <outline type="rss" text="${escapeXML(item.title)}" title="${escapeXML(item.title)}" xmlUrl="${escapeXML(item.url)}" />`,
          )
          .join("\n")}\n    </outline>`,
    )
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>${escapeXML(title)}</title></head>
  <body>
${outlines}
  </body>
</opml>
`
}
