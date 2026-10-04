import type {
  SourceCatalogParameter,
  SourceCatalogParameterValue,
  SourceCatalogRouteAdministration,
} from "@follow/feed-source-contracts"
import { z } from "zod"

import { SupplierAdminClient } from "./admin-client"
import { MemorySupplierRepository } from "./memory-repository"
import type { CreateCatalogRouteInput } from "./source-catalog"
import { SourceCatalogService } from "./source-catalog"

const parameterValue = z.union([z.boolean(), z.number(), z.string()])
const presetSchema = z
  .object({
    description: z.string(),
    routes: z
      .array(
        z
          .object({
            route: z
              .object({
                category: z.string(),
                description: z.string().nullable().optional(),
                documentationURL: z.string().nullable().optional(),
                key: z.string(),
                parameters: z.array(
                  z
                    .object({
                      defaultValue: parameterValue.nullable().optional(),
                      description: z.string().nullable().optional(),
                      key: z.string(),
                      label: z.string(),
                      location: z.enum(["path", "query"]),
                      maximum: z.number().int().nullable().optional(),
                      minimum: z.number().int().nullable().optional(),
                      options: z
                        .array(z.object({ label: z.string(), value: z.string() }))
                        .optional(),
                      required: z.boolean(),
                      type: z.enum(["boolean", "enum", "integer", "string"]),
                    })
                    .strict(),
                ),
                routePathTemplate: z.string(),
                rssHubCredentials: z
                  .array(z.object({ name: z.string(), required: z.boolean() }).strict())
                  .nullable()
                  .optional(),
                title: z.string(),
              })
              .strict(),
            testParameters: z.record(z.string(), parameterValue),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()

export interface CatalogPresetEntry {
  route: CreateCatalogRouteInput
  testParameters: Record<string, SourceCatalogParameterValue>
}

/**
 * Parse a catalog preset and create every route in an in-memory catalog, so template, parameter
 * and overlap rules fail before anything is sent to the supplier.
 */
export const parseCatalogPreset = async (text: string): Promise<CatalogPresetEntry[]> => {
  const preset = presetSchema.parse(JSON.parse(text))
  const entries = preset.routes.map(({ route, testParameters }): CatalogPresetEntry => {
    const parameters: SourceCatalogParameter[] = route.parameters.map((parameter) => ({
      defaultValue: parameter.defaultValue ?? null,
      description: parameter.description ?? null,
      key: parameter.key,
      label: parameter.label,
      location: parameter.location,
      maximum: parameter.maximum ?? null,
      minimum: parameter.minimum ?? null,
      options: parameter.options ?? [],
      required: parameter.required,
      type: parameter.type,
    }))
    // Templates are created disabled; the import enables a route only after its test passes.
    return {
      route: {
        ...route,
        description: route.description ?? null,
        documentationURL: route.documentationURL ?? null,
        enabled: false,
        parameters,
        rssHubCredentials: route.rssHubCredentials ?? null,
      },
      testParameters,
    }
  })
  const catalog = new SourceCatalogService(
    new MemorySupplierRepository(Buffer.alloc(32, 1)),
    "preset",
    new Map([["preset", Buffer.alloc(32, 2)]]),
  )
  for (const entry of entries) {
    try {
      // The in-memory copy is enabled so rendering also checks the sample test parameters.
      const created = await catalog.createRoute({ ...entry.route, enabled: true }, "preset")
      await catalog.render(created.id, entry.testParameters)
    } catch (error) {
      throw new Error(
        `Preset route ${entry.route.key} is invalid: ${error instanceof Error ? error.message : "unknown"}`,
      )
    }
  }
  return entries
}

export interface CatalogImportOptions {
  adminToken: string
  apply: boolean
  baseURL: string
  enable: boolean
  fetchImplementation?: typeof fetch
  only?: Set<string>
}

export type CatalogImportStatus =
  "created" | "enabled" | "exists" | "outdated" | "planned" | "test_failed" | "updated"

/**
 * Descriptive fields an existing template takes over from the preset. Templates, parameters and
 * bindings are left alone because changing them changes which addresses the route serves.
 */
const metadataChanges = (
  route: SourceCatalogRouteAdministration,
  preset: CatalogPresetEntry["route"],
) => {
  const changes: Partial<
    Pick<SourceCatalogRouteAdministration, "description" | "rssHubCredentials">
  > = {}
  if ((preset.description ?? null) !== (route.description ?? null))
    changes.description = preset.description ?? null
  if (
    preset.rssHubCredentials !== null &&
    preset.rssHubCredentials !== undefined &&
    JSON.stringify(preset.rssHubCredentials) !== JSON.stringify(route.rssHubCredentials)
  ) {
    changes.rssHubCredentials = preset.rssHubCredentials
  }
  return changes
}

export interface CatalogImportResult {
  contentBytes: number | null
  key: string
  logicalURL: string | null
  message: string | null
  status: CatalogImportStatus
}

interface CatalogTestResponse {
  contentBytes: number
  logicalURL: string
}

/**
 * Create the preset routes that do not exist yet (matched by key) and bring the description and
 * RSSHub credential declarations of existing ones up to date. With `enable`, each disabled route
 * is tested with its sample parameters and enabled only when the test passes.
 */
export const importCatalogPreset = async (
  entries: CatalogPresetEntry[],
  options: CatalogImportOptions,
): Promise<CatalogImportResult[]> => {
  const client = new SupplierAdminClient(
    options.baseURL,
    options.adminToken,
    options.fetchImplementation,
  )
  const { routes } = await client.request<{ routes: SourceCatalogRouteAdministration[] }>(
    "GET",
    "v1/admin/catalog/routes",
  )
  const existing = new Map(routes.map((route) => [route.key, route]))
  const results: CatalogImportResult[] = []
  for (const entry of entries) {
    if (options.only && !options.only.has(entry.route.key)) continue
    const base = {
      contentBytes: null,
      key: entry.route.key,
      logicalURL: null,
      message: null,
    }
    let route = existing.get(entry.route.key)
    if (!route && !options.apply) {
      results.push({ ...base, status: "planned" })
      continue
    }
    let status: CatalogImportStatus = route ? "exists" : "created"
    if (route) {
      const changes = metadataChanges(route, entry.route)
      if (Object.keys(changes).length > 0) {
        if (!options.apply) {
          results.push({ ...base, status: "outdated" })
          continue
        }
        ;({ route } = await client.request<{ route: SourceCatalogRouteAdministration }>(
          "PATCH",
          `v1/admin/catalog/routes/${route.id}`,
          changes,
        ))
        status = "updated"
      }
    }
    if (!route) {
      ;({ route } = await client.request<{ route: SourceCatalogRouteAdministration }>(
        "POST",
        "v1/admin/catalog/routes",
        entry.route,
      ))
    }
    if (!options.apply || !options.enable || route.enabled) {
      results.push({ ...base, status })
      continue
    }
    let tested: CatalogTestResponse
    try {
      // The supplier tests disabled templates for the owner, so nothing is enabled before it works.
      tested = await client.request<CatalogTestResponse>(
        "POST",
        `v1/admin/catalog/routes/${route.id}/test`,
        { parameters: entry.testParameters },
      )
    } catch (error) {
      results.push({
        ...base,
        message: error instanceof Error ? error.message : "Test failed",
        status: "test_failed",
      })
      continue
    }
    await client.request("PATCH", `v1/admin/catalog/routes/${route.id}`, { enabled: true })
    results.push({
      ...base,
      contentBytes: tested.contentBytes,
      logicalURL: tested.logicalURL,
      status: "enabled",
    })
  }
  return results
}
