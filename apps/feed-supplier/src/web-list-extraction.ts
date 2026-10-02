import type { WebListSource } from "@follow/feed-source-contracts"
import { parseHTML } from "linkedom"

import type { NoticeFact } from "./official-notice"
import { nearbyAttachments, noticeFacts, pruneNoticeBoilerplate } from "./official-notice"

export class WebListError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message)
  }
}

export const boundedUTF8 = (text: string, maximum: number): string => {
  const bytes = Buffer.from(text)
  let end = Math.min(maximum, bytes.length)
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString("utf8")
}
export const escapeXML = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
export const canonicalURL = (text: string, base: string): string | null => {
  try {
    const url = new URL(text, base)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
    url.hash = ""
    // Tracking parameters must not turn one notice into several items.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.*|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString().length <= 2048 ? url.toString() : null
  } catch {
    return null
  }
}

/** Resolve keys, numeric indexes and array wildcards without evaluating expressions. */
export const resolveJSONPath = (input: unknown, path: string): unknown[] => {
  if (path === "") return [input]
  const tokens = path.match(/[^.[\]]+|\[\d*\]/g) ?? []
  if (tokens.join(".").replaceAll(".[", "[") !== path.replace(/^\[/, "[")) return []
  let values: unknown[] = [input]
  for (const token of tokens) {
    values = values.flatMap((value): unknown[] => {
      if (token === "[]") return Array.isArray(value) ? value : []
      if (/^\[\d+\]$/.test(token))
        return Array.isArray(value) && Number(token.slice(1, -1)) < value.length
          ? [value[Number(token.slice(1, -1))]]
          : []
      return value !== null && typeof value === "object" && Object.hasOwn(value, token)
        ? [(value as Record<string, unknown>)[token]]
        : []
    })
  }
  return values
}
const scalar = (value: unknown): string | null =>
  typeof value === "string" || typeof value === "number" ? String(value) : null
/** JSON APIs often embed markup such as `<br/>` in titles; feeds need plain text. */
const plainText = (value: string | null): string | null => {
  if (value === null || !/[<&]/.test(value)) return value?.replace(/\s+/g, " ").trim() ?? null
  const { document } = parseHTML(`<html><body>${value.replace(/<br\s*\/?>/gi, " ")}</body></html>`)
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim()
}
const field = (value: unknown, path: string | null): string | null =>
  path === null ? null : scalar(resolveJSONPath(value, path)[0])

const zoneParts = (date: Date, timeZone: string): number[] => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  return ["year", "month", "day", "hour", "minute", "second"].map((type) =>
    Number(parts.find((part) => part.type === type)?.value),
  )
}
const localDate = (parts: number[], zone: string): number => {
  const [year, month, day, hour, minute, second] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  let instant = wall
  for (let iteration = 0; iteration < 4; iteration++) {
    const [y, m, d, h, min, sec] = zoneParts(new Date(instant), zone) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    const correction = wall - Date.UTC(y, m - 1, d, h, min, sec)
    if (!correction) break
    instant += correction
  }
  return zoneParts(new Date(instant), zone).every((part, index) => part === parts[index])
    ? instant
    : Number.NaN
}
export const parseListDate = (
  text: string | number,
  timeZone = "UTC",
  now = new Date(),
): string | null => {
  let timestamp = Number.NaN
  if (typeof text === "number" || /^\d{10}(?:\.\d+)?$|^\d{13}$/.test(text.trim())) {
    const number = Number(text)
    timestamp = Math.abs(number) < 1e12 ? number * 1000 : number
  } else {
    const value = text.trim()
    const full = value.match(
      /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/,
    )
    const short = value.match(/^\[?(\d{1,2})-(\d{1,2})\]?$/)
    if (full)
      timestamp = localDate(
        [
          Number(full[1]),
          Number(full[2]),
          Number(full[3]),
          Number(full[4] ?? 0),
          Number(full[5] ?? 0),
          Number(full[6] ?? 0),
        ],
        timeZone,
      )
    else if (short) {
      const parts = [zoneParts(now, timeZone)[0]!, Number(short[1]), Number(short[2]), 0, 0, 0]
      timestamp = localDate(parts, timeZone)
      if (timestamp > now.getTime() + 86400000) {
        parts[0]!--
        timestamp = localDate(parts, timeZone)
      }
    } else if (
      /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ||
      /\b(?:[A-Z]{3}|[+-]\d{4})$/i.test(value)
    )
      timestamp = Date.parse(value)
  }
  return Number.isFinite(timestamp) &&
    Math.abs(timestamp) <= 8640000000000000 &&
    timestamp <= now.getTime() + 86400000
    ? new Date(timestamp).toISOString()
    : null
}
const dateSubstring = (text: string): string =>
  text.match(
    /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?|\[?\b\d{2}-\d{2}\b\]?/,
  )?.[0] ?? ""
// Labels such as "发布时间：" surround most list dates; parse the date-like part when present.
const dateText = (text: string): string => dateSubstring(text) || text
const normalizedText = (element: Element | null): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim()
export const isTruncatedTitle = (title: string): boolean => /(?:\.\.\.|…)\s*$/.test(title)
export interface ExtractedListItem {
  /** Labelled facts from JSON `metadataPaths`, rendered above the content. */
  metadata: NoticeFact[]
  title: string
  url: string
  summary: string | null
  publishedAt: string | null
  identity: string
}
const allowed = (item: ExtractedListItem, source: WebListSource): boolean => {
  const f = source.filters
  const match = (patterns: string[], text: string) =>
    patterns.some((pattern) => new RegExp(pattern).test(text))
  return (
    (!f.includeURLPatterns.length || match(f.includeURLPatterns, item.url)) &&
    !match(f.excludeURLPatterns, item.url) &&
    (!f.includeTextPatterns.length || match(f.includeTextPatterns, item.title)) &&
    !match(f.excludeTextPatterns, item.title)
  )
}
const nextText = new Set(["next", "next page", "older", "more", "下一页", "下页", ">", "›", "»"])
export const extractHTMLList = (
  html: string,
  source: WebListSource,
  finalURL: string,
  now: Date,
): { items: ExtractedListItem[]; nextURL: string | null; refreshURL: string | null } => {
  const { document } = parseHTML(html)
  const config = source.html!
  const next = [...document.querySelectorAll("a[href]")].find((a) =>
    nextText.has(normalizedText(a).toLowerCase()),
  )
  const refresh = [...document.querySelectorAll("meta[http-equiv]")]
    .find((meta) => meta.getAttribute("http-equiv")?.toLowerCase() === "refresh")
    ?.getAttribute("content")
    ?.trim()
    .match(/^\d+\s*;\s*url\s*=(.*)$/i)?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, "")
  let elements: Element[] = []
  if (config.itemSelector) elements = [...document.querySelectorAll(config.itemSelector)]
  else {
    for (const parent of document.querySelectorAll("*")) {
      let excluded = false
      for (let ancestor: Element | null = parent; ancestor; ancestor = ancestor.parentElement) {
        if (
          ancestor.matches("header, nav, footer, aside") ||
          /header|nav|footer|sidebar|menu|pagination|pager/i.test(
            `${ancestor.id} ${ancestor.className}`,
          )
        ) {
          excluded = true
          break
        }
      }
      if (excluded) continue
      const children = [...parent.children].filter(
        (child) => child.matches("li, article, tr") && child.querySelector("a[href]"),
      )
      if (children.length >= 2 && children.length > elements.length) elements = children
    }
  }
  const items: ExtractedListItem[] = []
  const seen = new Set<string>()
  for (const element of elements) {
    const anchor = config.linkSelector
      ? [element, ...element.querySelectorAll(config.linkSelector)].find(
          (candidate) => candidate.matches(config.linkSelector!) && candidate.matches("a[href]"),
        )
      : element.matches("a[href]")
        ? element
        : element.querySelector("a[href]")
    if (!anchor || nextText.has(normalizedText(anchor).toLowerCase())) continue
    const url = canonicalURL(anchor.getAttribute("href") ?? "", finalURL)
    if (!url || seen.has(url)) continue
    const anchorText = normalizedText(anchor)
    const attribute = anchor.getAttribute("title") ?? ""
    const title = config.titleSelector
      ? normalizedText(element.querySelector(config.titleSelector))
      : isTruncatedTitle(anchorText) && attribute.length > anchorText.length
        ? attribute
        : anchorText || normalizedText(element)
    if (!title) continue
    const item = {
      metadata: [],
      title: [...title].slice(0, 300).join(""),
      url,
      identity: url,
      summary: config.summarySelector
        ? boundedUTF8(normalizedText(element.querySelector(config.summarySelector)), 4096) || null
        : null,
      publishedAt: parseListDate(
        dateText(
          config.dateSelector
            ? normalizedText(element.querySelector(config.dateSelector))
            : normalizedText(element),
        ),
        source.timeZone,
        now,
      ),
    }
    if (!allowed(item, source)) continue
    seen.add(url)
    items.push(item)
    if (items.length >= source.maxItems) break
  }
  return {
    items,
    nextURL: next ? canonicalURL(next.getAttribute("href")!, finalURL) : null,
    refreshURL: refresh ? canonicalURL(refresh, finalURL) : null,
  }
}
export const extractJSONList = (
  body: string,
  source: WebListSource,
  now: Date,
): ExtractedListItem[] => {
  let input: unknown
  try {
    input = JSON.parse(body)
  } catch {
    throw new WebListError("web_list_json_invalid", "Response is not valid JSON", 502)
  }
  const config = source.json!
  const resolved = resolveJSONPath(input, config.itemsPath)
  const values: unknown[] =
    resolved.length === 1 && Array.isArray(resolved[0]) ? resolved[0] : resolved
  const items: ExtractedListItem[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const title = plainText(field(value, config.titlePath))
    const rawURL =
      config.urlTemplate !== null
        ? config.urlTemplate.replace(/\{([^{}]+)\}/g, (_match, key: string) =>
            encodeURIComponent(
              scalar(
                value !== null && typeof value === "object" && Object.hasOwn(value, key)
                  ? (value as Record<string, unknown>)[key]
                  : null,
              ) ?? "",
            ),
          )
        : field(value, config.urlPath)
    const url = rawURL ? canonicalURL(rawURL, config.urlBase ?? source.targetURL) : null
    const identity = config.idPath !== null ? field(value, config.idPath) : url
    if (!title || !url || identity === null || seen.has(url)) continue
    const date = field(value, config.publishedAtPath)
    let publishedAt: string | null = null
    if (date !== null) {
      if (config.publishedAtFormat === "auto")
        publishedAt = parseListDate(date, source.timeZone, now)
      else {
        const timestamp = Number(date) * (config.publishedAtFormat === "unix_seconds" ? 1000 : 1)
        if (
          Number.isFinite(timestamp) &&
          Math.abs(timestamp) <= 8640000000000000 &&
          timestamp <= now.getTime() + 86400000
        )
          publishedAt = new Date(timestamp).toISOString()
      }
    }
    const summary = plainText(field(value, config.summaryPath))
    const metadata = Object.entries(config.metadataPaths).flatMap(([label, path]): NoticeFact[] => {
      const fact = plainText(field(value, path))
      return fact ? [[label, [...fact].slice(0, 256).join("")]] : []
    })
    const item = {
      metadata,
      title: [...title].slice(0, 300).join(""),
      url,
      identity: config.idPath !== null ? `id:${identity}` : url,
      summary: summary === null ? null : boundedUTF8(summary, 4096),
      publishedAt,
    }
    if (!allowed(item, source)) continue
    seen.add(url)
    items.push(item)
    if (items.length >= source.maxItems) break
  }
  return items
}

// Body containers used by Chinese government CMSs, in the order the earlier collector tried them.
const defaultContentSelectors = [
  "#UCAP-CONTENT",
  "#con_con",
  "#detail-editor",
  "#downloadContent",
  ".article_con",
  ".TRS_Editor",
  ".detail .article",
  ".detail",
  ".ccontent",
  ".content-block .detail",
  ".moe-detail-box",
  ".article",
]
const droppedTags = new Set(
  "audio button canvas embed input object select svg textarea video".split(" "),
)
/** The element with the most visible text, if any reaches the minimum length. */
const largest = (elements: Iterable<Element>, minimumLength: number): Element | undefined => {
  let best: Element | undefined
  let bestLength = minimumLength - 1
  for (const element of elements) {
    const length = normalizedText(element).length
    if (length > bestLength) {
      best = element
      bestLength = length
    }
  }
  return best
}
const contentRoot = (document: Document, selectors: string[]): Element => {
  // The first selector with a non-trivial match wins; its largest match is the body.
  for (const selector of selectors.length ? selectors : defaultContentSelectors) {
    const match = largest(document.querySelectorAll(selector), 20)
    if (match) return match
  }
  const candidates = [...document.querySelectorAll("article, main, section, div, td")].filter(
    (element) =>
      !/header|footer|nav|menu|toolbar|search/i.test(`${element.id} ${element.className}`),
  )
  // Semantic containers beat the largest-text heuristic, which can pick a whole-page wrapper.
  const semantic = document.querySelectorAll("main, article, [role=main]")
  const body = document.body?.textContent?.trim() ? document.body : null
  return (
    largest(semantic, 20) ??
    largest(candidates, 80) ??
    semantic[0] ??
    body ??
    document.documentElement
  )
}
const allowedTags = new Set(
  "p br h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr th td caption blockquote pre code strong em b i u s sub sup a img figure figcaption hr span div dl dt dd".split(
    " ",
  ),
)
/** Configured facts win; page facts fill in labels and values not already present. */
export const mergeNoticeFacts = (primary: NoticeFact[], secondary: NoticeFact[]): NoticeFact[] => {
  const merged = [...primary]
  for (const fact of secondary) {
    if (!merged.some(([label, value]) => label === fact[0] || value === fact[1])) merged.push(fact)
  }
  return merged
}
export const renderNoticeHeader = (facts: NoticeFact[]): string =>
  facts
    .map(([label, value]) => `<p><strong>${escapeXML(label)}</strong>：${escapeXML(value)}</p>`)
    .join("")

export interface DetailExtraction {
  content: string
  facts: NoticeFact[]
  publishedAt: string | null
  title: string
}

export const extractDetail = (
  html: string,
  source: WebListSource,
  finalURL: string,
  title: string,
  maximum = 128 * 1024,
  options: { metadata?: NoticeFact[]; now?: Date } = {},
): DetailExtraction => {
  const { document } = parseHTML(html)
  for (const element of document.querySelectorAll(
    [
      "script",
      "style",
      "noscript",
      "template",
      // Forms are unwrapped, not removed: VSB and ASP.NET pages wrap the whole page in one.
      "iframe",
      "nav",
      "header",
      "footer",
      // Controls never render, so they must not make a form look like the body either.
      ...droppedTags,
      ...source.detail.ignoreSelectors,
    ].join(","),
  ))
    element.remove()
  const root = contentRoot(document, source.detail.contentSelectors)
  const page = noticeFacts(document, root, title)
  pruneNoticeBoilerplate(root)
  const attachments = nearbyAttachments(root, (href) => canonicalURL(href, finalURL))
  const facts = mergeNoticeFacts(options.metadata ?? [], page.facts)
  const header = renderNoticeHeader(facts)
  const heading = normalizedText(root.querySelector("h1") ?? document.querySelector("h1"))
  if (isTruncatedTitle(title) && heading.startsWith(title.replace(/(?:\.\.\.|…)\s*$/, "")))
    title = [...heading].slice(0, 300).join("")
  const marker = "<p>[Content truncated]</p>"
  let remaining = maximum - Buffer.byteLength(marker) - Buffer.byteLength(header)
  let truncated = false
  const render = (node: ChildNode): string => {
    // Once the budget is spent nothing else is emitted, so the output stays a clean prefix.
    if (truncated) return ""
    if (node.nodeType === 3) {
      const text = node.textContent ?? ""
      let output = ""
      for (const character of text) {
        const escaped = escapeXML(character)
        const size = Buffer.byteLength(escaped)
        if (size > remaining) {
          truncated = true
          break
        }
        output += escaped
        remaining -= size
      }
      return output
    }
    if (node.nodeType !== 1) return ""
    const element = node as Element
    const tag = element.tagName.toLowerCase()
    if (droppedTags.has(tag)) return ""
    if (!allowedTags.has(tag)) return [...element.childNodes].map(render).join("")
    if (tag === "p" && !normalizedText(element) && !element.querySelector("img")) return ""
    const attrs: string[] = []
    for (const name of tag === "a"
      ? ["href"]
      : tag === "img"
        ? ["src", "alt"]
        : tag === "td" || tag === "th"
          ? ["colspan", "rowspan"]
          : []) {
      let value = element.getAttribute(name)
      if (value === null) continue
      if (name === "href" || name === "src") value = canonicalURL(value, finalURL)
      if (value !== null) attrs.push(` ${name}="${escapeXML(value)}"`)
    }
    const open = `<${tag}${attrs.join("")}>`
    const close = ["br", "img", "hr"].includes(tag) ? "" : `</${tag}>`
    const overhead = Buffer.byteLength(open + close)
    if (overhead > remaining) {
      truncated = true
      return ""
    }
    remaining -= overhead
    return open + (close ? [...element.childNodes].map(render).join("") : "") + close
  }
  const body = [...root.childNodes].map(render).join("")
  const attachmentList = attachments.length
    ? `<p><strong>附件</strong></p><ul>${attachments
        .map(
          ({ title: name, url }) => `<li><a href="${escapeXML(url)}">${escapeXML(name)}</a></li>`,
        )
        .join("")}</ul>`
    : ""
  const withAttachments =
    !truncated && Buffer.byteLength(attachmentList) <= remaining ? attachmentList : ""
  return {
    content: header + body + withAttachments + (truncated ? marker : ""),
    facts,
    publishedAt:
      page.publishedCandidates
        .map((candidate) => parseListDate(dateText(candidate), source.timeZone, options.now))
        .find(Boolean) ?? null,
    title,
  }
}
