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
import type { SourceRegistry } from "./source-registry"
import { SourceRegistryError } from "./source-registry"
import { SourceScalingError } from "./source-scaling"

export interface RouteTestResult {
  contentBytes: number
  contentType: string | null
  upstreamStatus: number
  upstreamURL: string
}

export interface RegisterSourceAdminRoutesOptions {
  catalog: SourceCatalogService
  registry: SourceRegistry
  pageChanges: PageChangeService
  server: FastifyInstance
  testRoute: (sourceURL: string) => Promise<RouteTestResult>
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
  secretQueryBindings,
  title: z.string().trim().min(1).max(128),
}
const catalogRouteCreate = z
  .object({
    ...catalogFields,
    description: catalogFields.description.optional(),
    documentationURL: catalogFields.documentationURL.optional(),
    enabled: catalogFields.enabled.optional(),
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

const actorFor = (request: FastifyRequest): string => {
  const actor = request.headers["x-folo-actor"]
  return typeof actor === "string" && /^[\w@. -]{1,128}$/.test(actor)
    ? actor
    : "feed-supplier-admin"
}

const invalidBody = (reply: FastifyReply, error: z.ZodError) =>
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
  if (error instanceof PageChangeError) {
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
        const rendered = await catalog.render(request.params.routeId, parsed.data.parameters)
        const result = await testRoute(rendered.logicalURL)
        await catalog.recordTest(request.params.routeId, actorFor(request), true)
        return { ...result, ...rendered }
      } catch (error) {
        await catalog.recordTest(request.params.routeId, actorFor(request), false)
        return handleAdminError(error, reply)
      }
    },
  )

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

  server.post("/v1/admin/credentials/rotate", async (request) => ({
    rotatedCount: await registry.rotateCredentials(actorFor(request)),
  }))

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
