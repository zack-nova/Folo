import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"

import { actorFor, invalidBody } from "./admin-routes"
import { OfficialAccountError } from "./official-account-service"
import type { OfficialBindingService } from "./official-binding-service"

const bindBody = z.object({ sourceURL: z.string().min(1).max(2_048) }).strict()

const handleError = (error: unknown, reply: FastifyReply) => {
  if (error instanceof OfficialAccountError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  throw error
}

/** Admin routes for official acquisition bindings (ADR-0034); `ADMIN_TOKEN` only. */
export const registerOfficialBindingRoutes = (
  server: FastifyInstance,
  service: OfficialBindingService,
): void => {
  server.get("/v1/admin/official/subscriptions", async (request, reply) => {
    try {
      return { subscriptions: await service.listOfficialSubscriptions(actorFor(request)) }
    } catch (error) {
      return handleError(error, reply)
    }
  })

  server.get("/v1/admin/official/bindings", async () => ({
    bindings: await service.listBindings(),
  }))

  server.post("/v1/admin/official/bindings", async (request, reply) => {
    const parsed = bindBody.safeParse(request.body)
    if (!parsed.success) return invalidBody(reply, parsed.error)
    try {
      const binding = await service.bind(parsed.data.sourceURL, actorFor(request))
      return reply.status(201).send({ binding })
    } catch (error) {
      return handleError(error, reply)
    }
  })

  server.post<{ Params: { bindingId: string } }>(
    "/v1/admin/official/bindings/:bindingId/retry",
    async (request, reply) => {
      try {
        return { binding: await service.retry(request.params.bindingId, actorFor(request)) }
      } catch (error) {
        return handleError(error, reply)
      }
    },
  )

  server.delete<{ Params: { bindingId: string } }>(
    "/v1/admin/official/bindings/:bindingId",
    async (request, reply) => {
      try {
        await service.unbind(request.params.bindingId, actorFor(request))
        return reply.status(204).send()
      } catch (error) {
        return handleError(error, reply)
      }
    },
  )
}
