import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import { RepositoryConflictError } from "./repository"
import type { SourceRegistry } from "./source-registry"
import { SourceRegistryError } from "./source-registry"

export interface RouteTestResult {
  contentBytes: number
  contentType: string | null
  upstreamStatus: number
  upstreamURL: string
}

export interface RegisterSourceAdminRoutesOptions {
  registry: SourceRegistry
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
  if (error instanceof SourceRegistryError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof RepositoryConflictError) {
    return reply.status(409).send({ code: "source_registry_conflict", message: error.message })
  }
  throw error
}

export const registerSourceAdminRoutes = ({
  registry,
  server,
  testRoute,
}: RegisterSourceAdminRoutesOptions): void => {
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
