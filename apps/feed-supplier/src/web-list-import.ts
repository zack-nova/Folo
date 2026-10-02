import type { WebListSource } from "@follow/feed-source-contracts"
import { z } from "zod"

import type { CreateWebListSourceInput } from "./web-list-validation"
import { validateWebListInput } from "./web-list-validation"

const presetSchema = z
  .object({
    defaults: z
      .object({ intervalMinutes: z.number().int().min(15).max(525_600).nullable() })
      .strict(),
    description: z.string(),
    sources: z
      .array(
        z
          .object({
            description: z.string().nullable(),
            key: z.string().min(1).max(128),
            source: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()

export interface WebListPresetEntry {
  description: string | null
  input: CreateWebListSourceInput
  key: string
}

export interface WebListPreset {
  entries: WebListPresetEntry[]
  intervalMinutes: number | null
}

/**
 * Parse a preset file and validate every source with the same rules as the admin API, so a
 * broken entry is reported before anything is sent to the supplier.
 */
export const parseWebListPreset = (text: string): WebListPreset => {
  const preset = presetSchema.parse(JSON.parse(text))
  const keys = new Set<string>()
  const names = new Set<string>()
  const entries = preset.sources.map(({ description, key, source }) => {
    if (keys.has(key)) throw new Error(`Duplicate preset key ${key}`)
    keys.add(key)
    // Sources are always created disabled; enabling happens after a successful test.
    const raw = { ...source, enabled: false, intervalMinutes: null } as CreateWebListSourceInput
    let input: CreateWebListSourceInput
    try {
      // Keep the normalized form (trimmed name, canonical URL) so name matching is idempotent.
      input = validateWebListInput(raw)
    } catch (error) {
      throw new Error(
        `Preset source ${key} is invalid: ${error instanceof Error ? error.message : "unknown"}`,
      )
    }
    if (names.has(input.name.toLowerCase())) throw new Error(`Duplicate preset name ${input.name}`)
    names.add(input.name.toLowerCase())
    return { description, input, key }
  })
  return { entries, intervalMinutes: preset.defaults.intervalMinutes }
}

export interface WebListImportOptions {
  adminToken: string
  apply: boolean
  baseURL: string
  enable: boolean
  fetchImplementation?: typeof fetch
  only?: Set<string>
}

export type WebListImportStatus =
  "created" | "detail_failed" | "enabled" | "exists" | "planned" | "test_empty" | "test_failed"

export interface WebListImportResult {
  detailStatus: string | null
  feedURL: string | null
  firstTitle: string | null
  itemCount: number | null
  key: string
  message: string | null
  name: string
  status: WebListImportStatus
}

interface TestResponse {
  detail: { detailStatus: string } | null
  items: { title: string }[]
}

class SupplierAdminClient {
  private readonly baseURL: URL
  private readonly fetchImplementation: typeof fetch

  constructor(
    baseURL: string,
    private readonly adminToken: string,
    fetchImplementation: typeof fetch = globalThis.fetch,
  ) {
    this.baseURL = new URL(`${baseURL.replace(/\/$/, "")}/`)
    this.fetchImplementation = fetchImplementation
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImplementation(new URL(path, this.baseURL), {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.adminToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
      // Detail previews can take a full fetch timeout per request.
      signal: AbortSignal.timeout(120_000),
    })
    const payload = (await response.json().catch(() => null)) as
      (T & { code?: string; message?: string }) | null
    if (!response.ok) {
      throw new Error(
        payload?.message
          ? `${payload.code ?? response.status}: ${payload.message}`
          : `HTTP ${response.status}`,
      )
    }
    return payload as T
  }
}

/**
 * Create the preset sources that do not exist yet (matched by name), test each new source
 * with a detail preview, and enable only those whose test extracted at least one item.
 */
export const importWebListPreset = async (
  preset: WebListPreset,
  options: WebListImportOptions,
): Promise<WebListImportResult[]> => {
  const client = new SupplierAdminClient(
    options.baseURL,
    options.adminToken,
    options.fetchImplementation,
  )
  const { sources: existing } = await client.request<{ sources: WebListSource[] }>(
    "GET",
    "v1/admin/web-list-sources",
  )
  const existingByName = new Map(existing.map((source) => [source.name.toLowerCase(), source]))
  const testAndEnable = async (
    source: WebListSource,
    created: WebListImportResult,
  ): Promise<WebListImportResult> => {
    let result = created
    try {
      const tested = await client.request<TestResponse>(
        "POST",
        `v1/admin/web-list-sources/${source.id}/test?detail=true`,
      )
      result = {
        ...result,
        detailStatus: tested.detail?.detailStatus ?? null,
        firstTitle: tested.items[0]?.title ?? null,
        itemCount: tested.items.length,
        // A failing detail preview usually means wrong body selectors or a blocked site.
        status: !tested.items.length
          ? "test_empty"
          : tested.detail?.detailStatus === "failed"
            ? "detail_failed"
            : result.status,
      }
    } catch (error) {
      return {
        ...result,
        message: error instanceof Error ? error.message : "Test failed",
        status: "test_failed",
      }
    }
    if (!options.enable || result.status === "test_empty" || result.status === "detail_failed") {
      return result
    }
    await client.request("PATCH", `v1/admin/web-list-sources/${source.id}`, {
      enabled: true,
      intervalMinutes: preset.intervalMinutes,
    })
    return { ...result, status: "enabled" }
  }

  const results: WebListImportResult[] = []
  for (const entry of preset.entries) {
    if (options.only && !options.only.has(entry.key)) continue
    const base = {
      detailStatus: null,
      firstTitle: null,
      itemCount: null,
      key: entry.key,
      message: null,
      name: entry.input.name,
    }
    const current = existingByName.get(entry.input.name.toLowerCase())
    if (current) {
      // A rerun with --enable finishes sources an earlier --apply left disabled.
      const pending = options.apply && options.enable && !current.enabled
      const existingResult = { ...base, feedURL: current.feedURL, status: "exists" as const }
      results.push(pending ? await testAndEnable(current, existingResult) : existingResult)
      continue
    }
    if (!options.apply) {
      results.push({ ...base, feedURL: null, status: "planned" })
      continue
    }
    const { source } = await client.request<{ source: WebListSource }>(
      "POST",
      "v1/admin/web-list-sources",
      entry.input,
    )
    results.push(
      await testAndEnable(source, { ...base, feedURL: source.feedURL, status: "created" }),
    )
  }
  return results
}
