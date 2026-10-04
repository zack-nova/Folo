import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import type {
  CreatePageChangeSourceInput,
  PageChangeService,
  UpdatePageChangeSourceInput,
} from "./page-change-service"
import { PageChangeError } from "./page-change-service"
import { RepositoryConflictError } from "./repository"
import type {
  CreateCatalogRouteInput,
  SourceCatalogService,
  UpdateCatalogRouteInput,
} from "./source-catalog"
import type { ResolvedRssHubSource, SourceRegistry } from "./source-registry"
import { SourceRegistryError } from "./source-registry"
import { SourceScalingError } from "./source-scaling"
import type { WebListService } from "./web-list-service"
import { WebListError } from "./web-list-service"
import { webListCreateSchema, webListUpdateSchema } from "./web-list-validation"

export interface RouteTestResult {
  contentBytes: number
  contentType: string | null
  upstreamStatus: number
  upstreamURL: string
}

export interface RegisterSourceAdminRoutesOptions {
  catalog: SourceCatalogService
  registry: SourceRegistry
  webLists: WebListService
  pageChanges: PageChangeService
  /** Re-encrypts public link tokens still under an older credential key; returns the count. */
  rotatePublicFeedTokens: (actor: string) => Promise<number>
  server: FastifyInstance
  testRoute: (sourceURL: string, preResolved?: ResolvedRssHubSource) => Promise<RouteTestResult>
}

const credentialName = z.string().trim().min(1).max(128)
const description = z.string().trim().max(500).nullable()
const secretValue = z.string().min(1).max(8_192)
const credentialCreate = z
  .object({ description: description.optional(), name: credentialName, value: secretValue })
  .strict()
const credentialUpdate = z
  .object({
    description: description.optional(),
    name: credentialName.optional(),
    value: secretValue.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required")

const queryParameter = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w.~-]+$/)
  .refine((value) => value.toLowerCase() !== "key", "RSSHub access key is reserved")
const secretQueryBindings = z
  .record(queryParameter, z.uuid())
  .refine((bindings) => Object.keys(bindings).length <= 16, "At most 16 bindings are supported")
const routeName = z.string().trim().min(1).max(128)
const routeCreate = z
  .object({
    enabled: z.boolean().optional(),
    name: routeName,
    secretQueryBindings: secretQueryBindings.optional(),
    sourceURL: z.string().min(1).max(2_048),
  })
  .strict()
const routeUpdate = z
  .object({
    enabled: z.boolean().optional(),
    name: routeName.optional(),
    secretQueryBindings: secretQueryBindings.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required")
const auditQuery = z.object({
  afterSequence: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
const webListItemQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
const eventQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(20) })
const pageSourceName = z.string().trim().min(1).max(128)
const pageTargetURL = z.string().trim().min(1).max(2_048)
const nullableSelector = z.string().trim().min(1).max(512).nullable()
const ignoreSelectors = z.array(z.string().trim().min(1).max(512)).max(16)
const intervalMinutes = z.number().int().min(15).max(525_600).nullable()
const confirmDelaySeconds = z.number().int().min(60).max(86_400)
const pageSourceCreate = z
  .object({
    confirmDelaySeconds: confirmDelaySeconds.optional(),
    contentSelector: nullableSelector.optional(),
    enabled: z.boolean().optional(),
    ignoreSelectors: ignoreSelectors.optional(),
    intervalMinutes: intervalMinutes.optional(),
    name: pageSourceName,
    targetURL: pageTargetURL,
  })
  .strict()
const pageSourceUpdate = z
  .object({
    confirmDelaySeconds: confirmDelaySeconds.optional(),
    contentSelector: nullableSelector.optional(),
    enabled: z.boolean().optional(),
    ignoreSelectors: ignoreSelectors.optional(),
    intervalMinutes: intervalMinutes.optional(),
    name: pageSourceName.optional(),
    targetURL: pageTargetURL.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required")

const catalogParameterKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z]\w*$/i)
const catalogParameter = z
  .object({
    defaultValue: z.union([z.boolean(), z.number().int(), z.string()]).nullable().default(null),
    description: z.string().trim().max(500).nullable().default(null),
    key: catalogParameterKey,
    label: z.string().trim().min(1).max(128),
    location: z.enum(["path", "query"]),
    maximum: z.number().int().safe().nullable().default(null),
    minimum: z.number().int().safe().nullable().default(null),
    options: z
      .array(
        z
          .object({ label: z.string().trim().min(1).max(128), value: z.string().min(1).max(256) })
          .strict(),
      )
      .max(100)
      .default([]),
    required: z.boolean(),
    type: z.enum(["boolean", "enum", "integer", "string"]),
  })
  .strict()
const catalogDocumentationURL = z
  .url()
  .max(2_048)
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "Documentation URL must use HTTP or HTTPS",
  })
/** An RSSHub environment variable, or a family of them such as BILIBILI_COOKIE_*. */
const rssHubCredentialRequirement = z
  .object({
    name: z
      .string()
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]*\*?$/, "Credential names are RSSHub environment variable names"),
    required: z.boolean(),
  })
  .strict()

const catalogFields = {
  category: z.string().trim().min(1).max(128),
  description: z.string().trim().max(1_000).nullable(),
  documentationURL: catalogDocumentationURL.nullable(),
  enabled: z.boolean(),
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  parameters: z.array(catalogParameter).max(32),
  routePathTemplate: z.string().min(2).max(1_024),
  rssHubCredentials: z.array(rssHubCredentialRequirement).max(16).nullable(),
  secretQueryBindings,
  title: z.string().trim().min(1).max(128),
}
const catalogRouteCreate = z
  .object({
    ...catalogFields,
    description: catalogFields.description.optional(),
    documentationURL: catalogFields.documentationURL.optional(),
    enabled: catalogFields.enabled.optional(),
    rssHubCredentials: catalogFields.rssHubCredentials.optional(),
    secretQueryBindings: catalogFields.secretQueryBindings.optional(),
  })
  .strict()
const catalogRouteUpdate = z
  .object(
    Object.fromEntries(
      Object.entries(catalogFields).map(([key, schema]) => [key, schema.optional()]),
    ) as { [Key in keyof typeof catalogFields]: z.ZodOptional<(typeof catalogFields)[Key]> },
  )
  .strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required")
const catalogRender = z
  .object({
    parameters: z.record(
      z.string().min(1).max(64),
      z.union([z.boolean(), z.number().safe(), z.string().max(512)]),
    ),
  })
  .strict()

export const actorFor = (request: FastifyRequest): string => {
  const actor = request.headers["x-folo-actor"]
  return typeof actor === "string" && /^[\w@. -]{1,128}$/.test(actor)
    ? actor
    : "feed-supplier-admin"
}

export const invalidBody = (reply: FastifyReply, error: z.ZodError) =>
  reply.status(400).send({
    code: "invalid_request",
    message: error.issues[0]?.message ?? "Request is invalid",
  })

const handleAdminError = (error: unknown, reply: FastifyReply) => {
  if (error instanceof SourceScalingError) {
    if (error.retryAfterSeconds) reply.header("retry-after", error.retryAfterSeconds)
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof SourceRegistryError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof PageChangeError || error instanceof WebListError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof RepositoryConflictError) {
    return reply.status(409).send({ code: "source_registry_conflict", message: error.message })
  }
  throw error
}

export const registerSourceAdminRoutes = ({
  catalog,
  registry,
  pageChanges,
  webLists,
  rotatePublicFeedTokens,
  server,
  testRoute,
}: RegisterSourceAdminRoutesOptions): void => {
  server.get("/v1/admin/catalog/routes", async () => ({
    routes: await catalog.listAdminRoutes(),
  }))

  server.post("/v1/admin/catalog/routes", async (request, reply) => {
    const parsed = catalogRouteCreate.safeParse(request.body)
    if (!parsed.success) return invalidBody(reply, parsed.error)
    try {
      const route = await catalog.createRoute(
        parsed.data as CreateCatalogRouteInput,
        actorFor(request),
      )
      return reply.status(201).send({ route })
    } catch (error) {
      return handleAdminError(error, reply)
    }
  })

  server.get<{ Params: { routeId: string } }>(
    "/v1/admin/catalog/routes/:routeId",
    async (request, reply) => {
      const route = await catalog.getAdminRoute(request.params.routeId)
      if (!route) {
        return reply
          .status(404)
          .send({ code: "catalog_route_not_found", message: "Catalog route was not found" })
      }
      return { route }
    },
  )

  server.patch<{ Params: { routeId: string } }>(
    "/v1/admin/catalog/routes/:routeId",
    async (request, reply) => {
      const parsed = catalogRouteUpdate.safeParse(request.body)
      if (!parsed.success) return invalidBody(reply, parsed.error)
      try {
        const route = await catalog.updateRoute(
          request.params.routeId,
          parsed.data as UpdateCatalogRouteInput,
          actorFor(request),
        )
        if (!route) {
          return reply
            .status(404)
            .send({ code: "catalog_route_not_found", message: "Catalog route was not found" })
        }
        return { route }
      } catch (error) {
        return handleAdminError(error, reply)
      }
    },
  )

  server.delete<{ Params: { routeId: string } }>(
    "/v1/admin/catalog/routes/:routeId",
    async (request, reply) => {
      const route = await catalog.deleteRoute(request.params.routeId, actorFor(request))
      if (!route) {
        return reply
          .status(404)
          .send({ code: "catalog_route_not_found", message: "Catalog route was not found" })
      }
      return reply.status(204).send()
    },
  )

  server.post<{ Params: { routeId: string } }>(
    "/v1/admin/catalog/routes/:routeId/test",
    async (request, reply) => {
      const parsed = catalogRender.safeParse(request.body)
      if (!parsed.success) return invalidBody(reply, parsed.error)
      try {
        // Owners may test a disabled template before enabling it.
        const { logicalURL, resolved } = await catalog.prepareTest(
          request.params.routeId,
          parsed.data.parameters,
        )
        const result = await testRoute(logicalURL, resolved)
        await catalog.recordTest(request.params.routeId, actorFor(request), true)
        return { ...result, logicalURL }
      } catch (error) {
        await catalog.recordTest(request.params.routeId, actorFor(request), false)
        return handleAdminError(error, reply)
      }
    },
  )

  registerWebListRoutes(server, webLists, "/v1/admin/web-list-sources")

  server.get("/v1/admin/page-sources", async () => ({ sources: await pageChanges.listSources() }))

  server.post("/v1/admin/page-sources", async (request, reply) => {
    const parsed = pageSourceCreate.safeParse(request.body)
    if (!parsed.success) return invalidBody(reply, parsed.error)
    try {
      const source = await pageChanges.createSource(
        parsed.data as CreatePageChangeSourceInput,
        actorFor(request),
      )
      return reply.status(201).send({ source })
    } catch (error) {
      return handleAdminError(error, reply)
    }
  })

  server.get<{ Params: { sourceId: string } }>(
    "/v1/admin/page-sources/:sourceId",
    async (request, reply) => {
      const source = await pageChanges.getSource(request.params.sourceId)
      if (!source) {
        return reply
          .status(404)
          .send({ code: "page_source_not_found", message: "Page source was not found" })
      }
      return { source }
    },
  )

  server.patch<{ Params: { sourceId: string } }>(
    "/v1/admin/page-sources/:sourceId",
    async (request, reply) => {
      const parsed = pageSourceUpdate.safeParse(request.body)
      if (!parsed.success) return invalidBody(reply, parsed.error)
      try {
        const source = await pageChanges.updateSource(
          request.params.sourceId,
          parsed.data as UpdatePageChangeSourceInput,
          actorFor(request),
        )
        if (!source) {
          return reply
            .status(404)
            .send({ code: "page_source_not_found", message: "Page source was not found" })
        }
        return { source }
      } catch (error) {
        return handleAdminError(error, reply)
      }
    },
  )

  server.delete<{ Params: { sourceId: string } }>(
    "/v1/admin/page-sources/:sourceId",
    async (request, reply) => {
      if (!(await pageChanges.deleteSource(request.params.sourceId, actorFor(request)))) {
        return reply
          .status(404)
          .send({ code: "page_source_not_found", message: "Page source was not found" })
      }
      return reply.status(204).send()
    },
  )

  server.post<{ Params: { sourceId: string } }>(
    "/v1/admin/page-sources/:sourceId/test",
    async (request, reply) => {
      try {
        const result = await pageChanges.testSource(request.params.sourceId, actorFor(request))
        if (!result) {
          return reply
            .status(404)
            .send({ code: "page_source_not_found", message: "Page source was not found" })
        }
        return result
      } catch (error) {
        return handleAdminError(error, reply)
      }
    },
  )

  server.post<{ Params: { sourceId: string } }>(
    "/v1/admin/page-sources/:sourceId/check",
    async (request, reply) => {
      try {
        const result = await pageChanges.checkSource(request.params.sourceId)
        if (!result) {
          return reply
            .status(404)
            .send({ code: "page_source_not_found", message: "Page source was not found" })
        }
        return result
      } catch (error) {
        return handleAdminError(error, reply)
      }
    },
  )

  server.get<{ Params: { sourceId: string } }>(
    "/v1/admin/page-sources/:sourceId/events",
    async (request, reply) => {
      const parsed = eventQuery.safeParse(request.query)
      if (!parsed.success) return invalidBody(reply, parsed.error)
      const events = await pageChanges.listEvents(request.params.sourceId, parsed.data.limit)
      if (!events) {
        return reply
          .status(404)
          .send({ code: "page_source_not_found", message: "Page source was not found" })
      }
      return { events }
    },
  )

  server.get("/v1/admin/credentials", async () => ({
    credentials: await registry.listCredentials(),
  }))

  server.post("/v1/admin/credentials", async (request, reply) => {
    const parsed = credentialCreate.safeParse(request.body)
    if (!parsed.success) return invalidBody(reply, parsed.error)
    try {
      const credential = await registry.createCredential(parsed.data, actorFor(request))
      return reply.status(201).send({ credential })
    } catch (error) {
      return handleAdminError(error, reply)
    }
  })

  server.patch<{ Params: { credentialId: string } }>(
    "/v1/admin/credentials/:credentialId",
    async (request, reply) => {
      const parsed = credentialUpdate.safeParse(request.body)
      if (!parsed.success) return invalidBody(reply, parsed.error)
      try {
        const credential = await registry.updateCredential(
          request.params.credentialId,
          parsed.data,
          actorFor(request),
        )
        if (!credential) {
          return reply
            .status(404)
            .send({ code: "source_credential_not_found", message: "Credential was not found" })
        }
        return { credential }
      } catch (error) {
        return handleAdminError(error, reply)
      }
    },
  )

  server.delete<{ Params: { credentialId: string } }>(
    "/v1/admin/credentials/:credentialId",
    async (request, reply) => {
      try {
        const credential = await registry.disableCredential(
          request.params.credentialId,
          actorFor(request),
        )
        if (!credential) {
          return reply
            .status(404)
            .send({ code: "source_credential_not_found", message: "Credential was not found" })
        }
        return reply.status(204).send()
      } catch (error) {
        return handleAdminError(error, reply)
      }
    },
  )

  server.post("/v1/admin/credentials/rotate", async (request) => {
    const rotatedCount = await registry.rotateCredentials(actorFor(request))
    // Public link tokens share the credential keyring, so retiring a key must cover them too.
    return { publicLinkRotatedCount: await rotatePublicFeedTokens(actorFor(request)), rotatedCount }
  })

  server.get("/v1/admin/routes", async () => ({ routes: await registry.listRoutes() }))

  server.post("/v1/admin/routes", async (request, reply) => {
    const parsed = routeCreate.safeParse(request.body)
    if (!parsed.success) return invalidBody(reply, parsed.error)
    try {
      const route = await registry.createRoute(parsed.data, actorFor(request))
      return reply.status(201).send({ route })
    } catch (error) {
      return handleAdminError(error, reply)
    }
  })

  server.patch<{ Params: { routeId: string } }>(
    "/v1/admin/routes/:routeId",
    async (request, reply) => {
      const parsed = routeUpdate.safeParse(request.body)
      if (!parsed.success) return invalidBody(reply, parsed.error)
      try {
        const route = await registry.updateRoute(
          request.params.routeId,
          parsed.data,
          actorFor(request),
        )
        if (!route) {
          return reply
            .status(404)
            .send({ code: "source_route_not_found", message: "Route was not found" })
        }
        return { route }
      } catch (error) {
        return handleAdminError(error, reply)
      }
    },
  )

  server.delete<{ Params: { routeId: string } }>(
    "/v1/admin/routes/:routeId",
    async (request, reply) => {
      const route = await registry.deleteRoute(request.params.routeId, actorFor(request))
      if (!route) {
        return reply
          .status(404)
          .send({ code: "source_route_not_found", message: "Route was not found" })
      }
      return reply.status(204).send()
    },
  )

  server.post<{ Params: { routeId: string } }>(
    "/v1/admin/routes/:routeId/test",
    async (request, reply) => {
      const route = await registry.getRoute(request.params.routeId)
      if (!route) {
        return reply
          .status(404)
          .send({ code: "source_route_not_found", message: "Route was not found" })
      }
      try {
        const result = await testRoute(route.sourceURL)
        await registry.recordRouteTest(route.id, actorFor(request), true)
        return result
      } catch (error) {
        await registry.recordRouteTest(route.id, actorFor(request), false)
        return handleAdminError(error, reply)
      }
    },
  )

  server.get("/v1/admin/audit", async (request, reply) => {
    const parsed = auditQuery.safeParse(request.query)
    if (!parsed.success) return invalidBody(reply, parsed.error)
    return {
      events: await registry.listAuditEvents(parsed.data.afterSequence, parsed.data.limit),
    }
  })

  server.get("/v1/admin/audit/verify", async () => registry.verifyAuditChain())
}

/**
 * Web list routes, registered for the admin token and, when configured, for the management
 * token the Folo core uses on behalf of the instance owner. Web list sources hold no secrets.
 */
export const registerWebListRoutes = (
  server: FastifyInstance,
  webLists: WebListService,
  base: "/v1/admin/web-list-sources" | "/v1/manage/web-list-sources",
): void => {
  server.get(base, async () => ({ sources: await webLists.listSources() }))

  server.post(base, async (request, reply) => {
    const parsed = webListCreateSchema.safeParse(request.body)
    if (!parsed.success) return invalidBody(reply, parsed.error)
    try {
      const source = await webLists.createSource(parsed.data, actorFor(request))
      return reply.status(201).send({ source })
    } catch (error) {
      return handleAdminError(error, reply)
    }
  })

  server.get<{ Params: { sourceId: string } }>(`${base}/:sourceId`, async (request, reply) => {
    const source = await webLists.getSource(request.params.sourceId)
    if (!source) {
      return reply
        .status(404)
        .send({ code: "web_list_source_not_found", message: "Web list source was not found" })
    }
    return { source }
  })

  server.patch<{ Params: { sourceId: string } }>(`${base}/:sourceId`, async (request, reply) => {
    const parsed = webListUpdateSchema.safeParse(request.body)
    if (!parsed.success) return invalidBody(reply, parsed.error)
    try {
      const source = await webLists.updateSource(
        request.params.sourceId,
        parsed.data,
        actorFor(request),
      )
      if (!source) {
        return reply
          .status(404)
          .send({ code: "web_list_source_not_found", message: "Web list source was not found" })
      }
      return { source }
    } catch (error) {
      return handleAdminError(error, reply)
    }
  })

  server.delete<{ Params: { sourceId: string } }>(`${base}/:sourceId`, async (request, reply) => {
    if (!(await webLists.deleteSource(request.params.sourceId, actorFor(request)))) {
      return reply
        .status(404)
        .send({ code: "web_list_source_not_found", message: "Web list source was not found" })
    }
    return reply.status(204).send()
  })

  server.post<{ Params: { sourceId: string } }>(
    `${base}/:sourceId/test`,
    async (request, reply) => {
      try {
        const query = z
          .object({ detail: z.enum(["true", "false"]).optional() })
          .strict()
          .safeParse(request.query)
        if (!query.success) return invalidBody(reply, query.error)
        const result = await webLists.testSource(
          request.params.sourceId,
          actorFor(request),
          query.data.detail === "true",
        )
        if (!result) {
          return reply
            .status(404)
            .send({ code: "web_list_source_not_found", message: "Web list source was not found" })
        }
        return result
      } catch (error) {
        return handleAdminError(error, reply)
      }
    },
  )

  server.post<{ Params: { sourceId: string } }>(
    `${base}/:sourceId/check`,
    async (request, reply) => {
      try {
        const result = await webLists.checkSource(request.params.sourceId)
        if (!result) {
          return reply
            .status(404)
            .send({ code: "web_list_source_not_found", message: "Web list source was not found" })
        }
        return result
      } catch (error) {
        return handleAdminError(error, reply)
      }
    },
  )

  server.get<{ Params: { sourceId: string } }>(
    `${base}/:sourceId/items`,
    async (request, reply) => {
      const parsed = webListItemQuery.safeParse(request.query)
      if (!parsed.success) return invalidBody(reply, parsed.error)
      const items = await webLists.listItems(request.params.sourceId, parsed.data.limit)
      if (!items) {
        return reply
          .status(404)
          .send({ code: "web_list_source_not_found", message: "Web list source was not found" })
      }
      return { items }
    },
  )
}
