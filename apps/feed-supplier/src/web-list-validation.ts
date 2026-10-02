import { parseHTML } from "linkedom"
import { z } from "zod"

import { WebListError } from "./web-list-extraction"

const selector = z.string().trim().min(1).max(512).nullable().default(null)
const path = z.string().max(512).nullable().default(null)
const patterns = z.array(z.string()).default([])
const html = z
  .object({
    itemSelector: selector,
    linkSelector: selector,
    titleSelector: selector,
    summarySelector: selector,
    dateSelector: selector,
  })
  .strict()
const json = z
  .object({
    itemsPath: z.string().max(512).default(""),
    titlePath: z.string().max(512),
    urlPath: path,
    urlTemplate: z.string().max(2048).nullable().default(null),
    urlBase: z.string().max(2048).nullable().default(null),
    idPath: path,
    summaryPath: path,
    publishedAtPath: path,
    publishedAtFormat: z.enum(["auto", "unix_seconds", "unix_milliseconds"]).default("auto"),
    metadataPaths: z
      .record(z.string().trim().min(1).max(32), z.string().max(512))
      .refine((paths) => Object.keys(paths).length <= 12, "At most 12 metadata paths are supported")
      .default({}),
  })
  .strict()
const filters = z
  .object({
    includeURLPatterns: patterns,
    excludeURLPatterns: patterns,
    includeTextPatterns: patterns,
    excludeTextPatterns: patterns,
  })
  .strict()
const detail = z
  .object({
    enabled: z.boolean().default(false),
    contentSelectors: z.array(z.string().min(1).max(512)).max(16).default([]),
    ignoreSelectors: z.array(z.string().min(1).max(512)).max(16).default([]),
  })
  .strict()
// Field schemas without defaults: defaults belong to creation only, so a PATCH that omits a
// field must leave the stored value alone instead of resetting it.
const sourceFields = {
  name: z.string().trim().min(1).max(128),
  targetURL: z.string().trim().min(1).max(2048),
  format: z.enum(["html", "json"]),
  html: html.nullable(),
  json: json.nullable(),
  filters,
  detail,
  maxItems: z.number().int().min(1).max(100),
  maxPages: z.number().int().min(1).max(10),
  timeZone: z.string().min(1).max(64),
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(15).max(525600).nullable(),
}
export const webListCreateSchema = z
  .object({
    ...sourceFields,
    html: sourceFields.html.optional(),
    json: sourceFields.json.optional(),
    filters: sourceFields.filters.prefault({}),
    detail: sourceFields.detail.prefault({}),
    maxItems: sourceFields.maxItems.default(20),
    maxPages: sourceFields.maxPages.default(1),
    timeZone: sourceFields.timeZone.default("UTC"),
    enabled: sourceFields.enabled.default(false),
    intervalMinutes: sourceFields.intervalMinutes.default(null),
  })
  .strict()
export const webListUpdateSchema = z
  .object(sourceFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required")
export type CreateWebListSourceInput = z.input<typeof webListCreateSchema>
export type UpdateWebListSourceInput = z.input<typeof webListUpdateSchema>
export const validateWebListURL = (text: string): string => {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new WebListError("web_list_url_invalid", "URL is invalid")
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new WebListError("web_list_url_invalid", "URL must use HTTP(S) without credentials")
  if (
    [...url.searchParams.keys()].some((key) =>
      /^(?:access_?token|api_?key|auth|key|signature|token)$/i.test(key),
    )
  )
    throw new WebListError(
      "web_list_url_secret_forbidden",
      "URL must not contain secret query parameters",
    )
  url.hash = ""
  return url.toString()
}
export const validateWebListInput = (input: CreateWebListSourceInput) => {
  const parsed = webListCreateSchema.safeParse(input)
  if (!parsed.success)
    throw new WebListError("invalid_request", parsed.error.issues[0]?.message ?? "Invalid request")
  const value = parsed.data
  if (
    value.format === "html" ? !value.html || value.json != null : !value.json || value.html != null
  )
    throw new WebListError(
      "web_list_extraction_invalid",
      "Exactly one extraction matching format is required",
    )
  if (value.json && (value.json.urlPath === null) === (value.json.urlTemplate === null))
    throw new WebListError(
      "web_list_extraction_invalid",
      "Exactly one of urlPath and urlTemplate is required",
    )
  value.targetURL = validateWebListURL(value.targetURL)
  if (value.json?.urlBase) value.json.urlBase = validateWebListURL(value.json.urlBase)
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).format()
  } catch {
    throw new WebListError("web_list_time_zone_invalid", "Invalid IANA time zone")
  }
  const { document } = parseHTML("<html><body></body></html>")
  for (const css of [
    ...Object.values(value.html ?? {}),
    ...value.detail.contentSelectors,
    ...value.detail.ignoreSelectors,
  ]) {
    if (css === null) continue
    try {
      document.querySelector(css)
    } catch {
      throw new WebListError("web_list_selector_invalid", "Invalid CSS selector")
    }
  }
  for (const list of Object.values(value.filters)) {
    if (list.length > 16)
      throw new WebListError(
        "web_list_pattern_invalid",
        "At most 16 patterns per list are supported",
      )
    for (const pattern of list) {
      if (pattern.length > 256)
        throw new WebListError(
          "web_list_pattern_invalid",
          "Patterns must be at most 256 characters",
        )
      try {
        new RegExp(pattern)
      } catch {
        throw new WebListError("web_list_pattern_invalid", "Invalid regular expression")
      }
    }
  }
  return { ...value, html: value.html ?? null, json: value.json ?? null }
}
