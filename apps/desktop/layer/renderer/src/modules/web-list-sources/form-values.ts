import type {
  WebListFormat,
  WebListPublishedAtFormat,
  WebListSource,
  WebListSourceInput,
  WebListSourcePatch,
} from "@follow/feed-source-contracts"

export const lines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
const nullable = (value: string) => value.trim() || null
export const initialWebListValues = (source?: WebListSource) => ({
  name: source?.name ?? "",
  targetURL: source?.targetURL ?? "",
  format: source?.format ?? ("html" as WebListFormat),
  itemSelector: source?.html?.itemSelector ?? "",
  linkSelector: source?.html?.linkSelector ?? "",
  titleSelector: source?.html?.titleSelector ?? "",
  dateSelector: source?.html?.dateSelector ?? "",
  summarySelector: source?.html?.summarySelector ?? "",
  itemsPath: source?.json?.itemsPath ?? "",
  titlePath: source?.json?.titlePath ?? "",
  urlPath: source?.json?.urlPath ?? "",
  urlTemplate: source?.json?.urlTemplate ?? "",
  urlBase: source?.json?.urlBase ?? "",
  idPath: source?.json?.idPath ?? "",
  summaryPath: source?.json?.summaryPath ?? "",
  publishedAtPath: source?.json?.publishedAtPath ?? "",
  publishedAtFormat: source?.json?.publishedAtFormat ?? ("auto" as WebListPublishedAtFormat),
  metadataPaths: Object.entries(source?.json?.metadataPaths ?? {})
    .map(([label, path]) => `${label}=${path}`)
    .join("\n"),
  includeTextPatterns: source?.filters.includeTextPatterns.join("\n") ?? "",
  excludeTextPatterns: source?.filters.excludeTextPatterns.join("\n") ?? "",
  includeURLPatterns: source?.filters.includeURLPatterns.join("\n") ?? "",
  excludeURLPatterns: source?.filters.excludeURLPatterns.join("\n") ?? "",
  detailEnabled: source?.detail.enabled ?? false,
  contentSelectors: source?.detail.contentSelectors.join("\n") ?? "",
  ignoreSelectors: source?.detail.ignoreSelectors.join("\n") ?? "",
  maxItems: String(source?.maxItems ?? 20),
  maxPages: String(source?.maxPages ?? 1),
  timeZone: source?.timeZone ?? "Asia/Shanghai",
  enabled: source?.enabled ?? false,
  intervalMinutes: source?.intervalMinutes == null ? "" : String(source.intervalMinutes),
})
export type WebListFormValues = ReturnType<typeof initialWebListValues>
export const webListInput = (v: WebListFormValues): WebListSourceInput => ({
  name: v.name.trim(),
  targetURL: v.targetURL.trim(),
  format: v.format,
  html:
    v.format === "html"
      ? {
          itemSelector: nullable(v.itemSelector),
          linkSelector: nullable(v.linkSelector),
          titleSelector: nullable(v.titleSelector),
          dateSelector: nullable(v.dateSelector),
          summarySelector: nullable(v.summarySelector),
        }
      : null,
  json:
    v.format === "json"
      ? {
          itemsPath: v.itemsPath.trim(),
          titlePath: v.titlePath.trim(),
          urlPath: nullable(v.urlPath),
          urlTemplate: nullable(v.urlTemplate),
          urlBase: nullable(v.urlBase),
          idPath: nullable(v.idPath),
          summaryPath: nullable(v.summaryPath),
          publishedAtPath: nullable(v.publishedAtPath),
          publishedAtFormat: v.publishedAtFormat,
          // `label=path` per line; lines without both parts are ignored rather than sent empty.
          metadataPaths: Object.fromEntries(
            lines(v.metadataPaths).flatMap((line) => {
              const index = line.indexOf("=")
              const label = index > 0 ? line.slice(0, index).trim() : ""
              const path = index > 0 ? line.slice(index + 1).trim() : ""
              return label && path ? [[label, path] as const] : []
            }),
          ),
        }
      : null,
  filters: {
    includeTextPatterns: lines(v.includeTextPatterns),
    excludeTextPatterns: lines(v.excludeTextPatterns),
    includeURLPatterns: lines(v.includeURLPatterns),
    excludeURLPatterns: lines(v.excludeURLPatterns),
  },
  detail: {
    enabled: v.detailEnabled,
    contentSelectors: lines(v.contentSelectors),
    ignoreSelectors: lines(v.ignoreSelectors),
  },
  maxItems: Number(v.maxItems),
  maxPages: Number(v.maxPages),
  timeZone: v.timeZone.trim(),
  enabled: v.enabled,
  intervalMinutes: v.intervalMinutes.trim() ? Number(v.intervalMinutes) : v.enabled ? 360 : null,
})
export const webListPatch = (values: WebListFormValues): WebListSourcePatch => webListInput(values)
