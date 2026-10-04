import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"

import { actorFor, invalidBody } from "./admin-routes"
import type { PublicFeedService } from "./public-feed-service"
import { PublicFeedError } from "./public-feed-service"
import { RepositoryConflictError } from "./repository"

/** Path of the public subscription route; the only one the reverse proxy may expose. */
export const PUBLIC_FEED_ROUTE = "/f/:token"

/** Misses per client address; tokens cannot be guessed, this only keeps scanners cheap. */
const MISSES_PER_MINUTE = 30
/** Reads per link; no reader needs to poll one feed this often. */
const READS_PER_MINUTE = 30

export interface InternalFeedResponse {
  statusCode: number
  headers: Record<string, string | string[] | number | undefined>
  body: string
}

/** Reads a logical source through the internal feed routes, keeping their caching and limits. */
export type InternalFeedReader = (
  sourceURL: string,
  conditional: { ifModifiedSince?: string; ifNoneMatch?: string },
) => Promise<InternalFeedResponse>

const WINDOW_MS = 60_000
const PRUNE_INTERVAL_MS = 10_000

/** Fixed one-minute windows, kept per process and bounded in size. */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; startedAt: number }>()
  private lastPrunedAt = 0

  constructor(
    private readonly limit: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** The seconds to wait while the key is over its limit, without counting a hit. */
  retryAfter(key: string, now = Date.now()): number | null {
    const window = this.windows.get(key)
    if (!window || now - window.startedAt >= WINDOW_MS || window.count < this.limit) return null
    return Math.ceil((window.startedAt + WINDOW_MS - now) / 1_000)
  }

  /** Counts a hit and returns the seconds to wait when the key is over its limit. */
  hit(key: string, now = Date.now()): number | null {
    const window = this.windows.get(key)
    if (!window || now - window.startedAt >= WINDOW_MS) {
      this.makeRoom(now)
      // Re-inserted keys move to the end, so the map stays ordered by window start.
      this.windows.delete(key)
      this.windows.set(key, { count: 1, startedAt: now })
      return null
    }
    window.count += 1
    return window.count > this.limit
      ? Math.ceil((window.startedAt + WINDOW_MS - now) / 1_000)
      : null
  }

  get size() {
    return this.windows.size
  }

  private makeRoom(now: number) {
    // Expired windows are dropped at most every few seconds, so many distinct clients cannot
    // turn every request into a full scan.
    if (now - this.lastPrunedAt >= PRUNE_INTERVAL_MS) {
      this.lastPrunedAt = now
      for (const [key, window] of this.windows) {
        if (now - window.startedAt < WINDOW_MS) break
        this.windows.delete(key)
      }
    }
    // Beyond the cap the oldest windows go first; forgetting a count only resets that window.
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break
      this.windows.delete(key)
    }
  }
}

const redactedToken = /^\/f\/[^/?]+/

/** Tokens live in the path, so request logs only keep the route. */
export const redactPublicFeedURL = (url: string) => url.replace(redactedToken, "/f/[Redacted]")

const notFound = (reply: FastifyReply) =>
  reply.status(404).send({ code: "not_found", message: "Not found" })

export const registerPublicFeedRoute = (
  server: FastifyInstance,
  service: PublicFeedService,
  readFeed: InternalFeedReader,
): void => {
  const misses = new FixedWindowLimiter(MISSES_PER_MINUTE)
  const reads = new FixedWindowLimiter(READS_PER_MINUTE)

  server.get<{ Params: { token: string } }>(PUBLIC_FEED_ROUTE, async (request, reply) => {
    reply.header("cache-control", "private, no-cache").header("x-robots-tag", "noindex, nofollow")
    const tooManyRequests = (retryAfter: number) =>
      reply
        .header("retry-after", retryAfter)
        .status(429)
        .send({ code: "rate_limited", message: "Too many requests" })

    // A client that keeps presenting unknown links is turned away before any lookup.
    const missBudget = misses.retryAfter(request.ip)
    if (missBudget !== null) return tooManyRequests(missBudget)
    const link = await service.resolve(request.params.token)
    if (!link) {
      const retryAfter = misses.hit(request.ip)
      return retryAfter === null ? notFound(reply) : tooManyRequests(retryAfter)
    }
    const retryAfter = reads.hit(link.id)
    if (retryAfter !== null) return tooManyRequests(retryAfter)

    void service
      .recordAccess(link.id, {
        at: new Date().toISOString(),
        ip: request.ip,
        userAgent: request.headers["user-agent"]?.slice(0, 512) ?? null,
      })
      .catch((error: unknown) =>
        request.log.warn({ err: error }, "Public feed access not recorded"),
      )

    const upstream = await readFeed(link.sourceURL, {
      ifModifiedSince: request.headers["if-modified-since"],
      ifNoneMatch: request.headers["if-none-match"],
    })
    // Only the feed and its validators leave; internal diagnostics stay inside.
    for (const header of ["content-type", "etag", "last-modified"]) {
      const value = upstream.headers[header]
      if (typeof value === "string") reply.header(header, value)
    }
    if (upstream.statusCode === 200) return reply.status(200).send(upstream.body)
    if (upstream.statusCode === 304) return reply.status(304).send()
    // A source deleted or disabled since the link was issued looks like any unknown link.
    if ([400, 404, 410].includes(upstream.statusCode)) return notFound(reply)
    if (upstream.statusCode === 429 || upstream.statusCode === 503) {
      const wait = Number(upstream.headers["retry-after"])
      if (Number.isFinite(wait) && wait > 0) reply.header("retry-after", wait)
      return reply.status(503).send({ code: "feed_busy", message: "Feed temporarily unavailable" })
    }
    return reply.status(502).send({ code: "feed_unavailable", message: "Feed unavailable" })
  })
}

const grantCreate = z.object({ name: z.string() }).strict()
const linkCreate = z.object({ sourceURL: z.string().min(1).max(2048) }).strict()

const handlePublicFeedError = (error: unknown, reply: FastifyReply) => {
  if (error instanceof PublicFeedError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof RepositoryConflictError) {
    return reply.status(409).send({ code: "public_feed_conflict", message: error.message })
  }
  throw error
}

/** Grant and link management; served under the admin token, never through the public proxy. */
export const registerPublicFeedAdminRoutes = (
  server: FastifyInstance,
  service: PublicFeedService,
): void => {
  const prefix = "/v1/admin/public-feed-grants"

  server.get(prefix, async () => ({ grants: await service.listGrants() }))

  server.post(prefix, async (request, reply) => {
    const parsed = grantCreate.safeParse(request.body)
    if (!parsed.success) return invalidBody(reply, parsed.error)
    try {
      return reply.status(201).send({
        grant: await service.createGrant(parsed.data.name, actorFor(request)),
      })
    } catch (error) {
      return handlePublicFeedError(error, reply)
    }
  })

  server.post<{ Params: { grantId: string } }>(
    `${prefix}/:grantId/revoke`,
    async (request, reply) => {
      try {
        await service.revokeGrant(request.params.grantId, actorFor(request))
        return reply.status(204).send()
      } catch (error) {
        return handlePublicFeedError(error, reply)
      }
    },
  )

  server.get<{ Params: { grantId: string } }>(
    `${prefix}/:grantId/links`,
    async (request, reply) => {
      try {
        return { links: await service.listLinks(request.params.grantId) }
      } catch (error) {
        return handlePublicFeedError(error, reply)
      }
    },
  )

  server.post<{ Params: { grantId: string } }>(
    `${prefix}/:grantId/links`,
    async (request, reply) => {
      const parsed = linkCreate.safeParse(request.body)
      if (!parsed.success) return invalidBody(reply, parsed.error)
      try {
        return reply.status(201).send({
          link: await service.issueLink(
            request.params.grantId,
            parsed.data.sourceURL,
            actorFor(request),
          ),
        })
      } catch (error) {
        return handlePublicFeedError(error, reply)
      }
    },
  )

  server.get<{ Params: { grantId: string } }>(
    `${prefix}/:grantId/export`,
    async (request, reply) => {
      try {
        return { links: await service.exportLinks(request.params.grantId) }
      } catch (error) {
        return handlePublicFeedError(error, reply)
      }
    },
  )

  server.post<{ Params: { grantId: string; linkId: string } }>(
    `${prefix}/:grantId/links/:linkId/rotate`,
    async (request, reply) => {
      try {
        return {
          link: await service.rotateLink(
            request.params.grantId,
            request.params.linkId,
            actorFor(request),
          ),
        }
      } catch (error) {
        return handlePublicFeedError(error, reply)
      }
    },
  )

  server.delete<{ Params: { grantId: string; linkId: string } }>(
    `${prefix}/:grantId/links/:linkId`,
    async (request, reply) => {
      try {
        await service.revokeLink(request.params.grantId, request.params.linkId, actorFor(request))
        return reply.status(204).send()
      } catch (error) {
        return handlePublicFeedError(error, reply)
      }
    },
  )
}
