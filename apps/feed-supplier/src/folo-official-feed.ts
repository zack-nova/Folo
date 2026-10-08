import { createHash } from "node:crypto"

import { z } from "zod"

import type { FoloOfficialClient } from "./folo-official-client"
import { OfficialAPIError } from "./folo-official-client"

/** Official entry fields the renderer uses; everything else the API returns is ignored. */
const officialEntrySchema = z.object({
  entries: z.object({
    attachments: z
      .array(
        z
          .object({
            mime_type: z.string().max(256).optional(),
            size_in_bytes: z.number().int().nonnegative().optional(),
            url: z.string().max(4_096),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
    author: z.string().max(1_024).nullable().optional(),
    categories: z.array(z.string().max(256)).nullable().optional(),
    content: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    guid: z.string().min(1).max(4_096),
    id: z.string().min(1).max(64),
    media: z
      .array(
        z
          .object({
            type: z.enum(["photo", "video"]).optional(),
            url: z.string().max(4_096),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
    publishedAt: z.string().max(64),
    title: z.string().nullable().optional(),
    url: z.string().max(4_096).nullable().optional(),
  }),
  feeds: z
    .object({
      description: z.string().nullable().optional(),
      image: z.string().max(4_096).nullable().optional(),
      siteUrl: z.string().max(4_096).nullable().optional(),
      title: z.string().nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
})
const officialEntryList = z.object({ data: z.array(z.unknown()) })

export type OfficialEntry = z.infer<typeof officialEntrySchema>

export interface OfficialFeedDocument {
  body: string
  /** Strong validator derived from the rendered body */
  etag: string
  entryCount: number
}

const escapeXML = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\u0000", "")

const rfc822 = (value: string): string => {
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? new Date().toUTCString() : new Date(timestamp).toUTCString()
}

/**
 * Renders official entries as RSS 2.0 for the core. The `guid` is the source GUID the official
 * service recorded, not its own entry id, so a later switch back to self-hosted RSSHub
 * de-duplicates on the same value (ADR-0034).
 */
export const renderOfficialFeed = (
  sourceURL: string,
  entries: OfficialEntry[],
): OfficialFeedDocument => {
  const feed = entries.find((entry) => entry.feeds)?.feeds ?? null
  const items = entries.map(({ entries: entry }) => {
    const parts = [
      `<guid isPermaLink="false">${escapeXML(entry.guid)}</guid>`,
      `<title>${escapeXML(entry.title ?? "")}</title>`,
      ...(entry.url ? [`<link>${escapeXML(entry.url)}</link>`] : []),
      `<pubDate>${rfc822(entry.publishedAt)}</pubDate>`,
      ...(entry.author ? [`<dc:creator>${escapeXML(entry.author)}</dc:creator>`] : []),
      ...(entry.description ? [`<description>${escapeXML(entry.description)}</description>`] : []),
      ...(entry.content ? [`<content:encoded>${escapeXML(entry.content)}</content:encoded>`] : []),
      ...(entry.categories ?? []).map((category) => `<category>${escapeXML(category)}</category>`),
      ...(entry.attachments ?? []).map(
        (attachment) =>
          `<enclosure url="${escapeXML(attachment.url)}"${
            attachment.mime_type ? ` type="${escapeXML(attachment.mime_type)}"` : ""
          }${
            attachment.size_in_bytes === undefined ? "" : ` length="${attachment.size_in_bytes}"`
          }/>`,
      ),
    ]
    return `<item>${parts.join("")}</item>`
  })
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "<channel>",
    `<title>${escapeXML(feed?.title ?? sourceURL)}</title>`,
    `<link>${escapeXML(feed?.siteUrl ?? sourceURL)}</link>`,
    `<description>${escapeXML(feed?.description ?? "Fetched through the owner's official Folo account")}</description>`,
    ...(feed?.image
      ? [
          `<image><url>${escapeXML(feed.image)}</url><title>${escapeXML(feed.title ?? sourceURL)}</title><link>${escapeXML(feed.siteUrl ?? sourceURL)}</link></image>`,
        ]
      : []),
    ...items,
    "</channel>",
    "</rss>",
  ].join("\n")
  return {
    body,
    entryCount: entries.length,
    etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`,
  }
}

/** Reads the newest page of a feed the official account subscribes to and renders it. */
export const fetchOfficialFeed = async (
  client: FoloOfficialClient,
  token: string,
  externalFeedId: string,
  sourceURL: string,
  limit: number,
): Promise<OfficialFeedDocument> => {
  const payload = await client.request("entries.list", token, {
    body: { feedId: externalFeedId, limit, withContent: true },
  })
  const list = officialEntryList.safeParse(payload)
  if (!list.success) {
    throw new OfficialAPIError("invalid_response", "The official entry list is invalid")
  }
  const entries: OfficialEntry[] = []
  for (const item of list.data.data) {
    const entry = officialEntrySchema.safeParse(item)
    if (!entry.success) {
      throw new OfficialAPIError("invalid_response", "An official entry has an unexpected shape")
    }
    entries.push(entry.data)
  }
  return renderOfficialFeed(sourceURL, entries)
}
