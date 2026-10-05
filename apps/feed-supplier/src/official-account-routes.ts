import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"

import { actorFor, invalidBody } from "./admin-routes"
import type { OfficialAccountService } from "./official-account-service"
import { OfficialAccountError } from "./official-account-service"

// The token is never echoed back, logged or written to the audit chain.
const linkBody = z.object({ token: z.string().min(1).max(4_096) }).strict()

const handleError = (error: unknown, reply: FastifyReply) => {
  if (error instanceof OfficialAccountError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  throw error
}

/** Admin routes for the official Folo account (ADR-0034); `ADMIN_TOKEN` only. */
export const registerOfficialAccountRoutes = (
  server: FastifyInstance,
  service: OfficialAccountService,
): void => {
  const path = "/v1/admin/official/account"

  server.get(path, async () => ({ account: await service.getAccount() }))

  server.post(path, async (request, reply) => {
    const parsed = linkBody.safeParse(request.body)
    if (!parsed.success) return invalidBody(reply, parsed.error)
    try {
      return reply
        .status(201)
        .send({ account: await service.link(parsed.data.token, actorFor(request)) })
    } catch (error) {
      return handleError(error, reply)
    }
  })

  server.post(`${path}/verify`, async (request, reply) => {
    try {
      return { account: await service.verify(actorFor(request)) }
    } catch (error) {
      return handleError(error, reply)
    }
  })

  server.delete(path, async (request, reply) => {
    try {
      await service.unlink(actorFor(request))
      return reply.status(204).send()
    } catch (error) {
      return handleError(error, reply)
    }
  })
}
