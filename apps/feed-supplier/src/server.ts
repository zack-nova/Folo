import { timingSafeEqual } from "node:crypto"

import { parseRssHubSource } from "@follow/feed-source-contracts"
import Fastify from "fastify"

import type { FeedSupplierConfig } from "./config"

export interface BuildFeedSupplierOptions {
  config: FeedSupplierConfig
  fetchImplementation?: typeof fetch
  logger?: boolean
}

const matchesSecret = (received: string | undefined, expected: string): boolean => {
  if (!received) return false
  const receivedBuffer = Buffer.from(received)
  const expectedBuffer = Buffer.from(expected)
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  )
}

const boundedBody = async (response: Response, maximumBytes: number): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`RSSHub response exceeds the ${maximumBytes} byte limit`)
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maximumBytes) {
      await reader.cancel()
      throw new Error(`RSSHub response exceeds the ${maximumBytes} byte limit`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
}

export const buildFeedSupplier = async ({
  config,
  fetchImplementation = globalThis.fetch,
  logger = false,
}: BuildFeedSupplierOptions) => {
  const server = Fastify({
    bodyLimit: 16 * 1024,
    logger: logger
      ? {
          redact: {
            censor: "[Redacted]",
            paths: ["req.headers.authorization", "req.query.url"],
          },
        }
      : false,
    requestTimeout: config.rssHubFetchTimeoutMs + 5_000,
  })
  const baseURL = new URL(`${config.rssHubBaseURL}/`)

  const upstreamURL = (input: string) => {
    const source = parseRssHubSource(input)
    const target = new URL(source.routePath.replace(/^\//, ""), baseURL)
    target.search = source.search
    if (config.rssHubAccessKey) target.searchParams.set("key", config.rssHubAccessKey)
    const diagnosticURL = new URL(target)
    diagnosticURL.searchParams.delete("key")
    return { source, target, diagnosticURL: diagnosticURL.toString() }
  }

  const fetchUpstream = async (target: URL, headers: Headers) => {
    let currentURL = target
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      const response = await fetchImplementation(currentURL, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(config.rssHubFetchTimeoutMs),
      })
      if (response.status < 300 || response.status >= 400 || response.status === 304) {
        return response
      }
      const location = response.headers.get("location")
      if (!location) throw new Error(`RSSHub redirect ${response.status} has no location`)
      if (redirectCount === 3) throw new Error("RSSHub returned too many redirects")
      const nextURL = new URL(location, currentURL)
      if (nextURL.origin !== baseURL.origin) {
        throw new Error("RSSHub redirect left the configured upstream origin")
      }
      currentURL = nextURL
    }
    throw new Error("RSSHub returned too many redirects")
  }

  const probeUpstream = async () => {
    try {
      const response = await fetchImplementation(baseURL, {
        headers: { accept: "text/html, application/json;q=0.9, */*;q=0.1" },
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(config.rssHubFetchTimeoutMs, 5_000)),
      })
      return response.status < 500
    } catch {
      return false
    }
  }

  server.get("/health", async () => ({ status: "ok" }))
  server.get("/ready", async (_request, reply) => {
    if (await probeUpstream()) return { status: "ready" }
    return reply.status(503).send({ status: "unavailable" })
  })

  server.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url === "/health" || request.routeOptions.url === "/ready") return
    const authorization = request.headers.authorization
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined
    if (!matchesSecret(token, config.internalToken)) {
      return reply
        .header("www-authenticate", 'Bearer realm="folo-feed-supplier"')
        .status(401)
        .send({ code: "unauthorized", message: "Supplier authentication required" })
    }
  })

  server.get("/v1/providers", async () => {
    const ready = await probeUpstream()
    return {
      providers: [
        {
          configured: true,
          id: "rsshub" as const,
          message: ready ? null : "Configured RSSHub instance is unavailable",
          status: ready ? ("ready" as const) : ("unavailable" as const),
        },
      ],
    }
  })

  server.get("/v1/feeds/rsshub", async (request, reply) => {
    const query = request.query as Record<string, unknown>
    if (typeof query.url !== "string") {
      return reply.status(400).send({ code: "invalid_source", message: "url is required" })
    }

    let sourceRequest: ReturnType<typeof upstreamURL>
    try {
      sourceRequest = upstreamURL(query.url)
    } catch (error) {
      return reply.status(400).send({
        code: "invalid_source",
        message: error instanceof Error ? error.message.slice(0, 500) : "Invalid RSSHub source",
      })
    }

    try {
      const { target, diagnosticURL } = sourceRequest
      const headers = new Headers({
        accept:
          "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
        "user-agent": "Folo-Feed-Supplier/1.0 (+self-hosted RSSHub)",
      })
      if (request.headers["if-none-match"]) {
        headers.set("if-none-match", request.headers["if-none-match"])
      }
      if (request.headers["if-modified-since"]) {
        headers.set("if-modified-since", request.headers["if-modified-since"])
      }
      const response = await fetchUpstream(target, headers)
      reply.header("x-folo-upstream-url", diagnosticURL)
      for (const header of ["content-type", "etag", "last-modified"] as const) {
        const value = response.headers.get(header)
        if (value) reply.header(header, value)
      }
      if (response.status === 304) return reply.status(304).send()
      if (!response.ok) {
        return reply.status(502).send({
          code: "rsshub_request_failed",
          message: `RSSHub request failed with HTTP ${response.status}`,
        })
      }
      return reply.status(200).send(await boundedBody(response, config.rssHubFetchMaxBytes))
    } catch (error) {
      return reply.status(502).send({
        code: "rsshub_request_failed",
        message: error instanceof Error ? error.message.slice(0, 500) : "RSSHub request failed",
      })
    }
  })

  await server.ready()
  return server
}
