import { createHash } from "node:crypto"

import { XMLParser } from "fast-xml-parser"

import type { EntryRecord, FeedRecord } from "../data/types"

type XMLValue = null | string | number | boolean | XMLNode | XMLValue[]
interface XMLNode {
  [key: string]: XMLValue
}

export interface ParsedFeed {
  entries: EntryRecord[]
  feed: FeedRecord
}

const array = <T>(value: T | T[] | null | undefined): T[] =>
  value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]

const object = (value: XMLValue | undefined): XMLNode | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : null

const text = (value: XMLValue | undefined): string | null => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim() || null
  }
  const node = object(value)
  return node ? text(node["#text"]) : null
}

const absoluteURL = (value: string | null, baseURL: string): string | null => {
  if (!value) return null
  try {
    return new URL(value, baseURL).toString()
  } catch {
    return null
  }
}

const date = (value: string | null, fallback: Date): Date => {
  if (!value) return fallback
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? fallback : new Date(timestamp)
}

const stableId = (prefix: "entry" | "feed", value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`

const rssFeed = (
  root: XMLNode,
  sourceURL: string,
  identityURL: string,
  fetchedAt: Date,
): ParsedFeed | null => {
  const channel = object(object(root.rss)?.channel)
  if (!channel) return null

  const feedId = stableId("feed", identityURL)
  const feed: FeedRecord = {
    id: feedId,
    url: identityURL,
    title: text(channel.title),
    description: text(channel.description),
    siteUrl: absoluteURL(text(channel.link), sourceURL),
    image: absoluteURL(text(object(channel.image)?.url), sourceURL),
    ownerUserId: null,
    errorAt: null,
    errorMessage: null,
    etag: null,
    lastModified: null,
    fetchedAt,
    consecutiveFailures: 0,
    lastSuccessAt: fetchedAt,
    nextFetchAt: fetchedAt,
  }

  const entries = array(channel.item)
    .map(object)
    .filter((item): item is XMLNode => item !== null)
    .map((item) => {
      const entryURL = absoluteURL(text(item.link), sourceURL)
      const guid =
        text(item.guid) ??
        entryURL ??
        `${text(item.title) ?? "untitled"}:${text(item.pubDate) ?? ""}`
      const enclosure = object(item.enclosure)
      const enclosureURL = absoluteURL(text(enclosure?.url), sourceURL)
      const publishedAt = date(text(item.pubDate) ?? text(item["dc:date"]), fetchedAt)

      return {
        id: stableId("entry", `${feedId}:${guid}`),
        feedId,
        guid,
        title: text(item.title),
        description: text(item.description),
        content: text(item["content:encoded"]) ?? text(item.description),
        url: entryURL,
        author: text(item.author) ?? text(item["dc:creator"]),
        authorUrl: null,
        authorAvatar: null,
        language: text(item.language) ?? text(channel.language),
        categories: array(item.category)
          .map(text)
          .filter((value): value is string => value !== null),
        attachments: enclosureURL
          ? [
              {
                url: enclosureURL,
                ...(text(enclosure?.type) ? { mime_type: text(enclosure?.type)! } : {}),
                ...(text(enclosure?.length) && Number.isFinite(Number(text(enclosure?.length)))
                  ? { size_in_bytes: Number(text(enclosure?.length)) }
                  : {}),
              },
            ]
          : null,
        media: null,
        extra: null,
        insertedAt: fetchedAt,
        publishedAt,
      } satisfies EntryRecord
    })

  return { feed, entries }
}

const atomLink = (
  value: XMLValue | undefined,
  relation: string,
  sourceURL: string,
): string | null => {
  for (const candidate of array(value).map(object)) {
    if (!candidate) continue
    const rel = text(candidate.rel) ?? "alternate"
    if (rel === relation) return absoluteURL(text(candidate.href), sourceURL)
  }
  return null
}

const atomFeed = (
  root: XMLNode,
  sourceURL: string,
  identityURL: string,
  fetchedAt: Date,
): ParsedFeed | null => {
  const atom = object(root.feed)
  if (!atom) return null

  const feedId = stableId("feed", identityURL)
  const feed: FeedRecord = {
    id: feedId,
    url: identityURL,
    title: text(atom.title),
    description: text(atom.subtitle),
    siteUrl: atomLink(atom.link, "alternate", sourceURL),
    image: absoluteURL(text(atom.logo) ?? text(atom.icon), sourceURL),
    ownerUserId: null,
    errorAt: null,
    errorMessage: null,
    etag: null,
    lastModified: null,
    fetchedAt,
    consecutiveFailures: 0,
    lastSuccessAt: fetchedAt,
    nextFetchAt: fetchedAt,
  }

  const entries = array(atom.entry)
    .map(object)
    .filter((item): item is XMLNode => item !== null)
    .map((item) => {
      const entryURL = atomLink(item.link, "alternate", sourceURL)
      const guid =
        text(item.id) ?? entryURL ?? `${text(item.title) ?? "untitled"}:${text(item.updated) ?? ""}`
      const author = object(item.author)
      const publishedAt = date(text(item.published) ?? text(item.updated), fetchedAt)

      return {
        id: stableId("entry", `${feedId}:${guid}`),
        feedId,
        guid,
        title: text(item.title),
        description: text(item.summary),
        content: text(item.content) ?? text(item.summary),
        url: entryURL,
        author: text(author?.name),
        authorUrl: absoluteURL(text(author?.uri), sourceURL),
        authorAvatar: null,
        language: null,
        categories: array(item.category)
          .map(object)
          .map((category) => text(category?.term))
          .filter((value): value is string => value !== null),
        attachments: null,
        media: null,
        extra: null,
        insertedAt: fetchedAt,
        publishedAt,
      } satisfies EntryRecord
    })

  return { feed, entries }
}

export const parseFeed = (
  xml: string,
  sourceURL: string,
  fetchedAt = new Date(),
  identityURL = sourceURL,
): ParsedFeed => {
  const parser = new XMLParser({
    attributeNamePrefix: "",
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: true,
    trimValues: true,
  })
  const root = parser.parse(xml) as XMLNode
  const parsed =
    rssFeed(root, sourceURL, identityURL, fetchedAt) ??
    atomFeed(root, sourceURL, identityURL, fetchedAt)

  if (!parsed) throw new Error("The response is not a supported RSS or Atom document")
  return parsed
}
