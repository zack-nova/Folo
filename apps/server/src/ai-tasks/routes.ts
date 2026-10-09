import { randomUUID } from "node:crypto"

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import type {
  AIChatMessageRecord,
  AIChatSessionRecord,
  AITaskPatch,
  AITaskRecord,
  DataStore,
} from "../data/types"
import { aiTaskScheduleSchema } from "./schedule"
import type { AITaskService } from "./service"

/** The client allows ten tasks; the server enforces the same limit. */
export const MAX_AI_TASKS = 10
const SESSION_PAGE_DEFAULT = 20
const SESSION_PAGE_MAX = 100

const notifyChannels = z.array(z.string()).max(5)
const taskOptionsSchema = z.object({ notifyChannels }).strict()
const taskFields = {
  name: z.string().trim().min(1).max(50),
  prompt: z.string().min(1).max(2_000),
  isEnabled: z.boolean(),
  schedule: aiTaskScheduleSchema,
  options: taskOptionsSchema,
}
const createTaskSchema = z.object({
  ...taskFields,
  isEnabled: taskFields.isEnabled.optional(),
})
const updateTaskSchema = z
  .object({
    name: taskFields.name,
    prompt: taskFields.prompt,
    isEnabled: taskFields.isEnabled,
    schedule: taskFields.schedule,
    options: taskFields.options,
  })
  .partial()

const apiTask = (task: AITaskRecord) => ({
  id: task.id,
  name: task.name,
  prompt: task.prompt,
  isEnabled: task.isEnabled,
  schedule: task.schedule,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
  lastRunAt: task.lastRunAt?.toISOString() ?? null,
  nextRunAt: task.nextRunAt?.toISOString() ?? null,
  runCount: task.runCount,
  lastResult: task.lastResult,
  lastError: task.lastError,
  options: task.options,
})

const apiSession = (session: AIChatSessionRecord) => ({
  chatId: session.chatId,
  userId: session.userId,
  title: session.title,
  createdAt: session.createdAt.toISOString(),
  updatedAt: session.updatedAt.toISOString(),
  lastSeenAt: session.lastSeenAt.toISOString(),
})

const apiMessage = (message: AIChatMessageRecord) => ({
  id: message.id,
  chatId: message.chatId,
  role: message.role,
  messageParts: message.messageParts,
  metadata: message.metadata,
  status: message.status,
  createdAt: message.createdAt.toISOString(),
  finishedAt: message.finishedAt?.toISOString() ?? null,
})

const invalid = (reply: FastifyReply, message: string) =>
  reply.status(400).send({ code: "invalid_request", message })

const firstIssue = (error: z.ZodError) => {
  const issue = error.issues.at(0)
  return issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request"
}

const pageLimit = (value: unknown): number | null => {
  if (value === undefined) return SESSION_PAGE_DEFAULT
  const limit = Number(value)
  return Number.isInteger(limit) && limit >= 1 && limit <= SESSION_PAGE_MAX ? limit : null
}

const pageCursor = (value: unknown): Date | null | undefined => {
  if (value === undefined) return undefined
  const date = typeof value === "string" ? new Date(value) : new Date(Number.NaN)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Reports are only delivered in the app. Email is a Folo cloud feature; this server cannot send
 * mail (ADR-0036), so any channel is refused rather than silently ignored.
 */
const unsupportedChannel = (options: { notifyChannels: string[] } | undefined) =>
  options?.notifyChannels.at(0) ?? null

export interface AITaskRouteDependencies {
  authenticatedUserId: (headers: FastifyRequest["headers"]) => Promise<string | null>
  dataStore: DataStore
  service: AITaskService
}

/** `ai.scheduled_tasks` (`/ai/task`) and `ai.task_reports` (`/ai/chat-sessions`) routes. */
export const registerAITaskRoutes = (
  server: FastifyInstance,
  { authenticatedUserId, dataStore, service }: AITaskRouteDependencies,
) => {
  const requireUser = async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      await reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
      return null
    }
    return userId
  }
  const taskNotFound = (reply: FastifyReply) =>
    reply.status(404).send({ code: "task_not_found", message: "Task not found" })
  const sessionNotFound = (reply: FastifyReply) =>
    reply.status(404).send({ code: "chat_session_not_found", message: "Chat session not found" })

  server.get("/ai/task", async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    return { code: 0, data: (await dataStore.listAITasks(userId)).map(apiTask) }
  })

  server.get<{ Params: { id: string } }>("/ai/task/:id", async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    const task = await dataStore.getAITask(userId, request.params.id)
    return task ? { code: 0, data: apiTask(task) } : taskNotFound(reply)
  })

  server.post("/ai/task", async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    const parsed = createTaskSchema.safeParse(request.body ?? {})
    if (!parsed.success) return invalid(reply, firstIssue(parsed.error))
    const channel = unsupportedChannel(parsed.data.options)
    if (channel) {
      return reply.status(400).send({
        code: "notify_channel_unsupported",
        message: `This server cannot deliver task reports by ${channel}`,
      })
    }
    if ((await dataStore.listAITasks(userId)).length >= MAX_AI_TASKS) {
      return reply.status(400).send({
        code: "task_limit_reached",
        message: `At most ${MAX_AI_TASKS} tasks are allowed`,
      })
    }
    const isEnabled = parsed.data.isEnabled ?? true
    const nextRunAt = service.nextRunAfterNow({ isEnabled, schedule: parsed.data.schedule })
    if (parsed.data.schedule.type === "once" && !nextRunAt && isEnabled) {
      return invalid(reply, "schedule.date: a one-off task must be scheduled in the future")
    }
    const now = new Date()
    const task: AITaskRecord = {
      createdAt: now,
      id: randomUUID(),
      isEnabled,
      lastError: null,
      lastResult: null,
      lastRunAt: null,
      name: parsed.data.name,
      nextRunAt,
      options: parsed.data.options,
      prompt: parsed.data.prompt,
      runCount: 0,
      schedule: parsed.data.schedule,
      updatedAt: now,
      userId,
    }
    await dataStore.createAITask(task)
    return { code: 0, data: apiTask(task) }
  })

  server.put<{ Params: { id: string } }>("/ai/task/:id", async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    const body = (request.body ?? {}) as Record<string, unknown>
    // The client repeats the id in the body; the path is authoritative.
    const { id: _id, ...fields } = body
    const parsed = updateTaskSchema.safeParse(fields)
    if (!parsed.success) return invalid(reply, firstIssue(parsed.error))
    const channel = unsupportedChannel(parsed.data.options)
    if (channel) {
      return reply.status(400).send({
        code: "notify_channel_unsupported",
        message: `This server cannot deliver task reports by ${channel}`,
      })
    }
    const existing = await dataStore.getAITask(userId, request.params.id)
    if (!existing) return taskNotFound(reply)
    const patch: AITaskPatch = { ...parsed.data, updatedAt: new Date() }
    const isEnabled = parsed.data.isEnabled ?? existing.isEnabled
    const schedule = parsed.data.schedule ?? existing.schedule
    // A changed schedule or a re-enabled task starts from the next slot; missed slots are not
    // caught up. Pausing clears the slot.
    if (parsed.data.schedule || parsed.data.isEnabled !== undefined) {
      patch.nextRunAt = service.nextRunAfterNow({ isEnabled, schedule })
    }
    const updated = await dataStore.updateAITask(userId, existing.id, patch)
    return updated ? { code: 0, data: apiTask(updated) } : taskNotFound(reply)
  })

  server.delete<{ Params: { id: string } }>("/ai/task/:id", async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    return (await dataStore.deleteAITask(userId, request.params.id))
      ? { code: 0 }
      : taskNotFound(reply)
  })

  server.post<{ Params: { id: string } }>("/ai/task/:id/test-run", async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    const task = await dataStore.getAITask(userId, request.params.id)
    if (!task) return taskNotFound(reply)
    const result = await service.testRun(task)
    return { code: 0, data: { taskId: task.id, ...result } }
  })

  server.get("/ai/chat-sessions", async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    const query = request.query as Record<string, unknown>
    const limit = pageLimit(query.limit)
    const before = pageCursor(query.before)
    if (limit === null) return invalid(reply, `limit must be 1-${SESSION_PAGE_MAX}`)
    if (before === null) return invalid(reply, "before must be an ISO date")
    const { sessions, total } = await dataStore.listAIChatSessions(userId, { before, limit })
    const last = sessions.at(-1)
    return {
      code: 0,
      data: sessions.map(apiSession),
      total,
      ...(sessions.length === limit && last ? { nextBefore: last.updatedAt.toISOString() } : {}),
    }
  })

  server.get("/ai/chat-sessions/unread", async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    const limit = pageLimit((request.query as Record<string, unknown>).limit)
    if (limit === null) return invalid(reply, `limit must be 1-${SESSION_PAGE_MAX}`)
    return { code: 0, data: await dataStore.listUnreadAIChatSessionIds(userId, limit) }
  })

  server.get<{ Params: { chatId: string } }>(
    "/ai/chat-sessions/:chatId",
    async (request, reply) => {
      const userId = await requireUser(request, reply)
      if (!userId) return reply
      const session = await dataStore.getAIChatSession(userId, request.params.chatId)
      return session ? { code: 0, data: apiSession(session) } : sessionNotFound(reply)
    },
  )

  server.patch<{ Params: { chatId: string } }>(
    "/ai/chat-sessions/:chatId",
    async (request, reply) => {
      const userId = await requireUser(request, reply)
      if (!userId) return reply
      const parsed = z
        .object({ title: z.string().trim().min(1).max(100) })
        .safeParse(request.body ?? {})
      if (!parsed.success) return invalid(reply, firstIssue(parsed.error))
      const session = await dataStore.updateAIChatSession(userId, request.params.chatId, {
        title: parsed.data.title,
      })
      return session ? { code: 0, data: apiSession(session) } : sessionNotFound(reply)
    },
  )

  server.delete<{ Params: { chatId: string } }>(
    "/ai/chat-sessions/:chatId",
    async (request, reply) => {
      const userId = await requireUser(request, reply)
      if (!userId) return reply
      return (await dataStore.deleteAIChatSession(userId, request.params.chatId))
        ? { code: 0, success: true }
        : sessionNotFound(reply)
    },
  )

  server.get<{ Params: { chatId: string } }>(
    "/ai/chat-sessions/:chatId/messages",
    async (request, reply) => {
      const userId = await requireUser(request, reply)
      if (!userId) return reply
      const query = request.query as Record<string, unknown>
      const limit = pageLimit(query.limit)
      const before = pageCursor(query.before)
      if (limit === null) return invalid(reply, `limit must be 1-${SESSION_PAGE_MAX}`)
      if (before === null) return invalid(reply, "before must be an ISO date")
      const session = await dataStore.getAIChatSession(userId, request.params.chatId)
      if (!session) return sessionNotFound(reply)
      const messages = await dataStore.listAIChatMessages(userId, session.chatId, {
        before,
        limit,
      })
      const oldest = messages.at(-1)
      return {
        code: 0,
        data: {
          chatSession: apiSession(session),
          // Pages are taken newest first; each page is returned in reading order.
          messages: messages.toReversed().map(apiMessage),
          ...(messages.length === limit && oldest
            ? { nextBefore: oldest.createdAt.toISOString() }
            : {}),
        },
      }
    },
  )

  server.post<{ Params: { chatId: string } }>(
    "/ai/chat-sessions/:chatId/mark-seen",
    async (request, reply) => {
      const userId = await requireUser(request, reply)
      if (!userId) return reply
      const body = (request.body ?? {}) as Record<string, unknown>
      const lastSeenAt = pageCursor(body.lastSeenAt) ?? (body.lastSeenAt ? null : new Date())
      if (lastSeenAt === null) return invalid(reply, "lastSeenAt must be an ISO date")
      const session = await dataStore.updateAIChatSession(userId, request.params.chatId, {
        lastSeenAt,
      })
      return session ? { code: 0, data: apiSession(session) } : sessionNotFound(reply)
    },
  )

  // Opening a session first asks whether a reply is still streaming. Reports are complete when
  // they are stored, so the answer for them is always "no active stream". General chat stays
  // unavailable.
  server.get<{ Params: { chatId: string } }>("/ai/chat/:chatId/stream", async (request, reply) => {
    const userId = await requireUser(request, reply)
    if (!userId) return reply
    const session = await dataStore.getAIChatSession(userId, request.params.chatId)
    if (!session) return sessionNotFound(reply)
    return reply.status(204).send()
  })
}
