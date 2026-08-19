import { randomUUID } from "node:crypto"

import type {
  RssHubSource,
  SourceCatalogParameter,
  SourceCatalogParameterValue,
  SourceCatalogRenderResult,
  SourceCatalogRoute,
  SourceCatalogRouteAdministration,
} from "@follow/feed-source-contracts"

import { createAuditDraft } from "./audit"
import { CredentialCipher } from "./credential-cipher"
import type { SupplierRepository } from "./repository"
import { SourceRegistryError } from "./source-registry"

export interface CreateCatalogRouteInput {
  category: string
  description?: string | null
  documentationURL?: string | null
  enabled?: boolean
  key: string
  parameters: SourceCatalogParameter[]
  routePathTemplate: string
  secretQueryBindings?: Record<string, string>
  title: string
}

export interface UpdateCatalogRouteInput {
  category?: string
  description?: string | null
  documentationURL?: string | null
  enabled?: boolean
  key?: string
  parameters?: SourceCatalogParameter[]
  routePathTemplate?: string
  secretQueryBindings?: Record<string, string>
  title?: string
}

export interface ResolvedCatalogSource {
  route: SourceCatalogRouteAdministration
  secretQuery: Record<string, string>
}

const maximumLogicalURLLength = 2_048

const publicRoute = (route: SourceCatalogRouteAdministration): SourceCatalogRoute => ({
  category: route.category,
  createdAt: route.createdAt,
  description: route.description,
  documentationURL: route.documentationURL,
  enabled: route.enabled,
  id: route.id,
  key: route.key,
  parameters: route.parameters,
  requiresCredentials: Object.keys(route.secretQueryBindings).length > 0,
  routePathTemplate: route.routePathTemplate,
  title: route.title,
  updatedAt: route.updatedAt,
})

const invalidCatalog = (message: string): never => {
  throw new SourceRegistryError("invalid_catalog_route", message, 400)
}

const parameterValue = (
  parameter: SourceCatalogParameter,
  value: unknown,
): SourceCatalogParameterValue => {
  if (parameter.type === "string") {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) {
      return invalidCatalog(`${parameter.label} must be a non-empty string`)
    }
    return value
  }
  if (parameter.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      (parameter.minimum !== null && value < parameter.minimum) ||
      (parameter.maximum !== null && value > parameter.maximum)
    ) {
      return invalidCatalog(`${parameter.label} must be an integer within the configured range`)
    }
    return value
  }
  if (parameter.type === "boolean") {
    if (typeof value !== "boolean") return invalidCatalog(`${parameter.label} must be a boolean`)
    return value
  }
  if (typeof value !== "string" || !parameter.options.some((option) => option.value === value)) {
    return invalidCatalog(`${parameter.label} must use a configured option`)
  }
  return value
}

const parameterValueFromString = (
  parameter: SourceCatalogParameter,
  value: string,
): SourceCatalogParameterValue =>
  parameterValue(
    parameter,
    parameter.type === "integer"
      ? Number(value)
      : parameter.type === "boolean"
        ? value === "true"
          ? true
          : value === "false"
            ? false
            : value
        : value,
  )

const templateSegments = (template: string): string[] => {
  if (
    !template.startsWith("/") ||
    template.length > 1_024 ||
    template.includes("?") ||
    template.includes("#")
  ) {
    return invalidCatalog(
      "Route template must be an absolute RSSHub path without query or fragment",
    )
  }
  const segments = template.slice(1).split("/")
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        (!segment.startsWith(":") && !/^[\w.~-]+$/.test(segment)) ||
        (segment.startsWith(":") && !/^:[A-Z]\w*$/i.test(segment)),
    )
  ) {
    return invalidCatalog("Route template contains an invalid segment")
  }
  return segments
}

const validateRouteDefinition = (
  route: Pick<
    SourceCatalogRouteAdministration,
    "parameters" | "routePathTemplate" | "secretQueryBindings"
  >,
): void => {
  const parameters = new Map<string, SourceCatalogParameter>()
  for (const parameter of route.parameters) {
    if (!/^[A-Z]\w{0,63}$/i.test(parameter.key)) {
      invalidCatalog("Catalog parameter key is invalid")
    }
    if (parameters.has(parameter.key)) invalidCatalog(`Parameter ${parameter.key} is duplicated`)
    parameters.set(parameter.key, parameter)
    if (parameter.location === "query" && parameter.key.toLowerCase() === "key") {
      invalidCatalog("RSSHub access key is reserved")
    }
    if (parameter.location === "path" && !parameter.required) {
      invalidCatalog(`Path parameter ${parameter.key} must be required`)
    }
    if (parameter.type === "enum" && parameter.options.length === 0) {
      invalidCatalog(`Enum parameter ${parameter.key} must define options`)
    }
    if (parameter.type !== "enum" && parameter.options.length > 0) {
      invalidCatalog(`Only enum parameter ${parameter.key} may define options`)
    }
    if (
      parameter.type === "enum" &&
      new Set(parameter.options.map((option) => option.value)).size !== parameter.options.length
    ) {
      invalidCatalog(`Enum parameter ${parameter.key} contains duplicate options`)
    }
    if (
      parameter.type !== "integer" &&
      (parameter.minimum !== null || parameter.maximum !== null)
    ) {
      invalidCatalog(`Only integer parameter ${parameter.key} may define a numeric range`)
    }
    if (
      parameter.minimum !== null &&
      parameter.maximum !== null &&
      parameter.minimum > parameter.maximum
    ) {
      invalidCatalog(`Parameter ${parameter.key} has an invalid numeric range`)
    }
    if (parameter.defaultValue !== null) parameterValue(parameter, parameter.defaultValue)
  }

  const placeholders = templateSegments(route.routePathTemplate)
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1))
  if (new Set(placeholders).size !== placeholders.length) {
    invalidCatalog("Route template contains a duplicate placeholder")
  }
  const pathParameters = route.parameters
    .filter((parameter) => parameter.location === "path")
    .map((parameter) => parameter.key)
  if (
    placeholders.length !== pathParameters.length ||
    placeholders.some((key) => !pathParameters.includes(key))
  ) {
    invalidCatalog("Route template placeholders must exactly match path parameters")
  }

  for (const secretName of Object.keys(route.secretQueryBindings)) {
    if (secretName.toLowerCase() === "key") invalidCatalog("RSSHub access key is reserved")
    if (parameters.has(secretName)) {
      invalidCatalog(`Secret query parameter ${secretName} conflicts with a public parameter`)
    }
  }
}

const staticSegmentAcceptedBy = (
  route: SourceCatalogRouteAdministration,
  placeholder: string,
  segment: string,
): boolean => {
  const parameter = route.parameters.find(
    (candidate) => candidate.location === "path" && candidate.key === placeholder.slice(1),
  )
  if (!parameter) return false
  try {
    parameterValueFromString(parameter, segment)
    return true
  } catch (error) {
    if (error instanceof SourceRegistryError) return false
    throw error
  }
}

const templatesOverlap = (
  left: SourceCatalogRouteAdministration,
  right: SourceCatalogRouteAdministration,
): boolean => {
  const leftSegments = templateSegments(left.routePathTemplate)
  const rightSegments = templateSegments(right.routePathTemplate)
  if (leftSegments.length !== rightSegments.length) return false
  return leftSegments.every((leftSegment, index) => {
    const rightSegment = rightSegments[index]!
    const leftPlaceholder = leftSegment.startsWith(":")
    const rightPlaceholder = rightSegment.startsWith(":")
    if (!leftPlaceholder && !rightPlaceholder) return leftSegment === rightSegment
    if (leftPlaceholder && !rightPlaceholder) {
      return staticSegmentAcceptedBy(left, leftSegment, rightSegment)
    }
    if (!leftPlaceholder && rightPlaceholder) {
      return staticSegmentAcceptedBy(right, rightSegment, leftSegment)
    }
    return true
  })
}

const templateSpecificity = (route: SourceCatalogRouteAdministration): number =>
  templateSegments(route.routePathTemplate).filter((segment) => !segment.startsWith(":")).length

const valuesFromSource = (
  route: SourceCatalogRouteAdministration,
  source: RssHubSource,
): Record<string, SourceCatalogParameterValue> | null => {
  const expectedSegments = templateSegments(route.routePathTemplate)
  const actualSegments = source.routePath
    .slice(1)
    .split("/")
    .map((segment) => decodeURIComponent(segment))
  if (expectedSegments.length !== actualSegments.length) return null

  const values: Record<string, SourceCatalogParameterValue> = {}
  for (const [index, expected] of expectedSegments.entries()) {
    const actual = actualSegments[index]!
    if (!expected.startsWith(":")) {
      if (expected !== actual) return null
      continue
    }
    const key = expected.slice(1)
    const parameter = route.parameters.find((candidate) => candidate.key === key)!
    values[key] = parameterValueFromString(parameter, actual)
  }

  const search = new URLSearchParams(source.search)
  const queryParameters = new Map(
    route.parameters
      .filter((parameter) => parameter.location === "query")
      .map((parameter) => [parameter.key, parameter]),
  )
  if ([...search.keys()].some((key) => !queryParameters.has(key))) return null
  for (const [key, parameter] of queryParameters) {
    const rawValues = search.getAll(key)
    if (rawValues.length > 1) invalidCatalog(`Parameter ${key} must not be repeated`)
    if (rawValues.length === 0) {
      if (parameter.required && parameter.defaultValue === null) return null
      continue
    }
    const raw = rawValues[0]!
    values[key] = parameterValueFromString(parameter, raw)
  }
  return values
}

export class SourceCatalogService {
  private readonly cipher: CredentialCipher

  constructor(
    private readonly repository: SupplierRepository,
    activeKeyId: string,
    keys: ReadonlyMap<string, Buffer>,
  ) {
    this.cipher = new CredentialCipher(activeKeyId, keys)
  }

  async listPublicRoutes(): Promise<SourceCatalogRoute[]> {
    return (await this.repository.listCatalogRoutes())
      .filter((route) => route.enabled)
      .map(publicRoute)
  }

  async listAdminRoutes(): Promise<SourceCatalogRouteAdministration[]> {
    return this.repository.listCatalogRoutes()
  }

  async getAdminRoute(id: string): Promise<SourceCatalogRouteAdministration | null> {
    return this.repository.findCatalogRouteById(id)
  }

  async createRoute(
    input: CreateCatalogRouteInput,
    actor: string,
  ): Promise<SourceCatalogRouteAdministration> {
    const now = new Date().toISOString()
    const route: SourceCatalogRouteAdministration = {
      category: input.category,
      createdAt: now,
      deletedAt: null,
      description: input.description ?? null,
      documentationURL: input.documentationURL ?? null,
      enabled: input.enabled ?? true,
      id: randomUUID(),
      key: input.key,
      parameters: input.parameters,
      requiresCredentials: Object.keys(input.secretQueryBindings ?? {}).length > 0,
      routePathTemplate: input.routePathTemplate,
      secretQueryBindings: input.secretQueryBindings ?? {},
      title: input.title,
      updatedAt: now,
    }
    validateRouteDefinition(route)
    await this.assertTemplateAvailable(route)
    await this.assertBindingsAvailable(route.secretQueryBindings)
    return this.repository.createCatalogRoute(
      route,
      createAuditDraft(actor, "catalog_route.created", "catalog_route", route.id, {
        bindingCount: Object.keys(route.secretQueryBindings).length,
        enabled: route.enabled,
        key: route.key,
        parameterCount: route.parameters.length,
      }),
    )
  }

  async updateRoute(
    id: string,
    input: UpdateCatalogRouteInput,
    actor: string,
  ): Promise<SourceCatalogRouteAdministration | null> {
    const current = await this.repository.findCatalogRouteById(id)
    if (!current) return null
    const bindings = input.secretQueryBindings ?? current.secretQueryBindings
    const route: SourceCatalogRouteAdministration = {
      ...current,
      category: input.category ?? current.category,
      description: input.description === undefined ? current.description : input.description,
      documentationURL:
        input.documentationURL === undefined ? current.documentationURL : input.documentationURL,
      enabled: input.enabled ?? current.enabled,
      key: input.key ?? current.key,
      parameters: input.parameters ?? current.parameters,
      requiresCredentials: Object.keys(bindings).length > 0,
      routePathTemplate: input.routePathTemplate ?? current.routePathTemplate,
      secretQueryBindings: bindings,
      title: input.title ?? current.title,
      updatedAt: new Date().toISOString(),
    }
    validateRouteDefinition(route)
    await this.assertTemplateAvailable(route)
    await this.assertBindingsAvailable(bindings)
    return this.repository.updateCatalogRoute(
      route,
      createAuditDraft(actor, "catalog_route.updated", "catalog_route", id, {
        bindingCount: Object.keys(bindings).length,
        enabled: route.enabled,
        key: route.key,
        parameterCount: route.parameters.length,
      }),
    )
  }

  async deleteRoute(id: string, actor: string): Promise<SourceCatalogRouteAdministration | null> {
    return this.repository.softDeleteCatalogRoute(
      id,
      new Date().toISOString(),
      createAuditDraft(actor, "catalog_route.deleted", "catalog_route", id, {}),
    )
  }

  async render(id: string, values: Record<string, unknown>): Promise<SourceCatalogRenderResult> {
    const route = await this.repository.findCatalogRouteById(id)
    if (!route || !route.enabled) {
      throw new SourceRegistryError("catalog_route_not_found", "Catalog route was not found", 404)
    }
    const knownKeys = new Set(route.parameters.map((parameter) => parameter.key))
    const unknownKey = Object.keys(values).find((key) => !knownKeys.has(key))
    if (unknownKey) invalidCatalog(`Unknown parameter ${unknownKey}`)

    const resolved: Record<string, SourceCatalogParameterValue> = {}
    for (const parameter of route.parameters) {
      const supplied = values[parameter.key]
      if (supplied === undefined || supplied === "") {
        if (parameter.defaultValue !== null) resolved[parameter.key] = parameter.defaultValue
        else if (parameter.required) invalidCatalog(`${parameter.label} is required`)
        continue
      }
      resolved[parameter.key] = parameterValue(parameter, supplied)
    }

    const path = templateSegments(route.routePathTemplate)
      .map((segment) => {
        if (!segment.startsWith(":")) return segment
        const value = String(resolved[segment.slice(1)])
        if (value === "." || value === "..") {
          invalidCatalog("Path parameters must not be dot segments")
        }
        return encodeURIComponent(value)
      })
      .join("/")
    const logicalURL = new URL(`rsshub://${path}`)
    for (const parameter of route.parameters.filter((item) => item.location === "query")) {
      const value = resolved[parameter.key]
      if (value !== undefined) logicalURL.searchParams.set(parameter.key, String(value))
    }
    const renderedURL = logicalURL.toString()
    if (renderedURL.length > maximumLogicalURLLength) {
      invalidCatalog(`Rendered source URL must not exceed ${maximumLogicalURLLength} characters`)
    }
    return { logicalURL: renderedURL }
  }

  async resolve(source: RssHubSource): Promise<ResolvedCatalogSource | null> {
    const routes = (await this.repository.listCatalogRoutes())
      .filter((route) => route.enabled)
      .sort(
        (left, right) =>
          templateSpecificity(right) - templateSpecificity(left) ||
          left.key.localeCompare(right.key),
      )
    for (const route of routes) {
      let values: Record<string, SourceCatalogParameterValue> | null
      try {
        values = valuesFromSource(route, source)
      } catch (error) {
        if (error instanceof URIError) continue
        throw error
      }
      if (!values) continue
      return { route, secretQuery: await this.resolveSecrets(route.secretQueryBindings) }
    }
    return null
  }

  async recordTest(routeId: string, actor: string, succeeded: boolean): Promise<void> {
    if (!(await this.repository.findCatalogRouteById(routeId))) return
    await this.repository.recordAudit(
      createAuditDraft(actor, "catalog_route.tested", "catalog_route", routeId, { succeeded }),
    )
  }

  private async assertTemplateAvailable(route: SourceCatalogRouteAdministration): Promise<void> {
    const conflict = (await this.repository.listCatalogRoutes()).find(
      (candidate) => candidate.id !== route.id && templatesOverlap(candidate, route),
    )
    if (conflict) {
      throw new SourceRegistryError(
        "catalog_route_conflict",
        `Catalog route overlaps with ${conflict.key}`,
        409,
      )
    }
  }

  private async assertBindingsAvailable(bindings: Record<string, string>): Promise<void> {
    for (const credentialId of new Set(Object.values(bindings))) {
      const credential = await this.repository.findCredential(credentialId)
      if (!credential || credential.disabledAt) {
        throw new SourceRegistryError(
          "source_credential_not_found",
          `Active credential ${credentialId} was not found`,
          400,
        )
      }
    }
  }

  private async resolveSecrets(bindings: Record<string, string>): Promise<Record<string, string>> {
    const secrets: Record<string, string> = {}
    for (const [parameter, credentialId] of Object.entries(bindings)) {
      const credential = await this.repository.findCredential(credentialId)
      if (!credential || credential.disabledAt) {
        throw new SourceRegistryError(
          "source_credential_unavailable",
          `Credential bound to query parameter ${parameter} is unavailable`,
          503,
        )
      }
      try {
        secrets[parameter] = this.cipher.decrypt(credential.id, credential)
      } catch {
        throw new SourceRegistryError(
          "source_credential_unavailable",
          `Credential bound to query parameter ${parameter} cannot be decrypted`,
          503,
        )
      }
    }
    return secrets
  }
}
