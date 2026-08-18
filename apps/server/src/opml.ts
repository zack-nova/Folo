import { XMLParser } from "fast-xml-parser"

interface XMLNode {
  [key: string]: XMLValue
}

type XMLValue = null | string | number | boolean | XMLNode | XMLValue[]

export interface OpmlSubscription {
  category: string | null
  title: string | null
  url: string
  view: number
}

export interface ExportedSubscription extends OpmlSubscription {
  siteUrl: string | null
}

const array = <T>(value: T | T[] | null | undefined): T[] =>
  value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]

const object = (value: XMLValue | undefined): XMLNode | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : null

const string = (value: XMLValue | undefined): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null
  return String(value).trim() || null
}

const feedURL = (value: string | null): string | null => {
  if (!value || value.length > 4096) return null
  try {
    const parsed = new URL(value)
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null
    }
    parsed.hash = ""
    return parsed.toString()
  } catch {
    return null
  }
}

const outlineName = (outline: XMLNode): string | null =>
  string(outline.title) ?? string(outline.text)

export const parseOpml = (xml: string, maximum = 10_000): OpmlSubscription[] => {
  if (!xml.trim()) throw new Error("The OPML document is empty")

  const parser = new XMLParser({
    attributeNamePrefix: "",
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: false,
    trimValues: true,
  })
  const root = parser.parse(xml) as XMLNode
  const body = object(object(root.opml)?.body)
  if (!body) throw new Error("The document is not valid OPML")

  const subscriptions: OpmlSubscription[] = []
  const seen = new Set<string>()

  const visit = (value: XMLValue | undefined, inheritedCategory: string | null, depth: number) => {
    if (depth > 32) throw new Error("The OPML outline is too deeply nested")
    for (const outline of array(value).map(object)) {
      if (!outline) continue
      const url = feedURL(string(outline.xmlUrl) ?? string(outline.xmlurl))
      const title = outlineName(outline)
      if (url) {
        if (!seen.has(url)) {
          if (subscriptions.length >= maximum) {
            throw new Error(`The OPML document contains more than ${maximum} subscriptions`)
          }
          seen.add(url)
          const requestedView = Number(string(outline.view))
          subscriptions.push({
            category: inheritedCategory,
            title,
            url,
            view: Number.isInteger(requestedView) && requestedView >= 0 ? requestedView : 0,
          })
        }
      } else {
        visit(outline.outline, title ?? inheritedCategory, depth + 1)
      }
    }
  }

  visit(body.outline, null, 0)
  return subscriptions
}

const escapeXML = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

const outline = (subscription: ExportedSubscription, indentation: string): string => {
  const title = subscription.title ?? subscription.url
  const attributes = [
    `text="${escapeXML(title)}"`,
    `title="${escapeXML(title)}"`,
    'type="rss"',
    `xmlUrl="${escapeXML(subscription.url)}"`,
    ...(subscription.siteUrl ? [`htmlUrl="${escapeXML(subscription.siteUrl)}"`] : []),
    ...(subscription.view === 0 ? [] : [`view="${subscription.view}"`]),
  ]
  return `${indentation}<outline ${attributes.join(" ")} />`
}

export const exportOpml = (subscriptions: ExportedSubscription[]): string => {
  const uncategorized = subscriptions.filter((subscription) => !subscription.category)
  const categories = new Map<string, ExportedSubscription[]>()
  for (const subscription of subscriptions) {
    if (!subscription.category) continue
    const grouped = categories.get(subscription.category) ?? []
    grouped.push(subscription)
    categories.set(subscription.category, grouped)
  }

  const body = [
    ...uncategorized.map((subscription) => outline(subscription, "    ")),
    ...[...categories.entries()].flatMap(([category, grouped]) => [
      `    <outline text="${escapeXML(category)}" title="${escapeXML(category)}">`,
      ...grouped.map((subscription) => outline(subscription, "      ")),
      "    </outline>",
    ]),
  ]

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    "    <title>Folo subscriptions</title>",
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    "  </head>",
    "  <body>",
    ...body,
    "  </body>",
    "</opml>",
  ].join("\n")
}
