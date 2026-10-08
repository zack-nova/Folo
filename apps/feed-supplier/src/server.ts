import { timingSafeEqual } from "node:crypto"

import type { OfficialAcquisitionBinding } from "@follow/feed-source-contracts"
import { parseRssHubSource } from "@follow/feed-source-contracts"
import type { FastifyReply, FastifyRequest } from "fastify"
import Fastify from "fastify"
import { z } from "zod"

import { registerSourceAdminRoutes, registerWebListRoutes } from "./admin-routes"
import type { FeedSupplierConfig } from "./config"
import { CredentialCipher } from "./credential-cipher"
import { resolveCredentialDependency } from "./credential-dependency"
import type { OfficialTransport } from "./folo-official-client"
import { fetchTransport, FoloOfficialClient, proxyTransport } from "./folo-official-client"
import { MemorySupplierRepository } from "./memory-repository"
import { registerOfficialAccountRoutes } from "./official-account-routes"
import {
  OfficialAccountError,
  OfficialAccountService,
  reencryptOfficialAccountToken,
} from "./official-account-service"
import { registerOfficialBindingRoutes } from "./official-binding-routes"
import { OfficialBindingService } from "./official-binding-service"
import { PageChangeError, PageChangeService, startPageChangeScheduler } from "./page-change-service"
import { PageFetcher } from "./page-fetcher"
import { PostgresSupplierRepository } from "./postgres-repository"
import {
  PUBLIC_FEED_ROUTE,
  redactPublicFeedURL,
  registerPublicFeedAdminRoutes,
  registerPublicFeedRoute,
} from "./public-feed-routes"
import {
  PublicFeedError,
  PublicFeedService,
  reencryptPublicFeedTokens,
} from "./public-feed-service"
import { RedisSourceResponseCache } from "./redis-source-response-cache"
import type { SupplierRepository } from "./repository"
import { secretQueryParameter } from "./secret-parameters"
import { SourceCatalogService } from "./source-catalog"
import type { ResolvedRssHubSource } from "./source-registry"
import { SourceRegistry, SourceRegistryError } from "./source-registry"
import type { CachedRssHubResponse, SourceResponseCache } from "./source-scaling"
import {
  MemorySourceResponseCache,
  SourceRequestCoalescer,
  SourceScalingError,
  SourceScalingTelemetry,
} from "./source-scaling"
import { WebListFetcher } from "./web-list-fetcher"
import {
  startWebListScheduler,
  WEB_LIST_DETAIL_BUDGET_MS,
  WebListError,
  WebListService,
} from "./web-list-service"

export interface BuildFeedSupplierOptions {
  config: FeedSupplierConfig
  fetchImplementation?: typeof fetch
  logger?: boolean
  /** Replaces the official API transport in tests */
  officialTransport?: OfficialTransport
  webListFetcher?: WebListFetcher
  pageFetcher?: PageFetcher
  repository?: SupplierRepository
  responseCache?: SourceResponseCache
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

const safeUpstreamErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return "RSSHub request failed"
  if (
    error.message.startsWith("RSSHub response exceeds the ") ||
    error.message === "RSSHub returned too many redirects" ||
    error.message === "RSSHub redirect left the configured upstream origin" ||
    /^RSSHub redirect \d{3} has no location$/.test(error.message)
  ) {
    return error.message.slice(0, 500)
  }
  return "RSSHub request failed"
}

export const buildFeedSupplier = async ({
  config,
  fetchImplementation: providedFetchImplementation,
  logger = false,
  officialTransport: providedOfficialTransport,
  pageFetcher: providedPageFetcher,
  webListFetcher: providedWebListFetcher,
  repository: providedRepository,
  responseCache: providedResponseCache,
}: BuildFeedSupplierOptions) => {
  const fetchImplementation = providedFetchImplementation ?? globalThis.fetch
  const repository =
    providedRepository ??
    (config.nodeEnvironment === "test"
      ? new MemorySupplierRepository(config.auditHmacKey)
      : config.databaseURL
        ? new PostgresSupplierRepository({
            auditKey: config.auditHmacKey,
            connectionString: config.databaseURL,
            maxConnections: config.databaseMaxConnections,
          })
        : null)
  if (!repository) throw new Error("Feed supplier DATABASE_URL is required outside tests")
  await repository.initialize()
  const catalog = new SourceCatalogService(
    repository,
    config.credentialActiveKeyId,
    config.credentialKeys,
  )
  const registry = new SourceRegistry(
    repository,
    config.credentialActiveKeyId,
    config.credentialKeys,
    config.registryMode,
    catalog,
  )
  const pageFetcher =
    providedPageFetcher ??
    new PageFetcher({
      fetchImplementation: providedFetchImplementation,
      maxBytes: config.pageFetchMaxBytes,
      maxContentBytes: config.pageContentMaxBytes,
      timeoutMs: config.pageFetchTimeoutMs,
    })
  const webLists = new WebListService(
    repository,
    providedWebListFetcher ??
      new WebListFetcher({
        fetchImplementation: providedFetchImplementation,
        maxBytes: config.webListFetchMaxBytes,
        timeoutMs: config.webListFetchTimeoutMs,
        requestDelayMs: config.webListRequestDelayMs,
      }),
  )
  const pageChanges = new PageChangeService(repository, pageFetcher)
  const officialConfig = config.officialAcquisition
  const officialClient = officialConfig
    ? new FoloOfficialClient({
        apiURL: officialConfig.apiURL,
        timeoutMs: officialConfig.fetchTimeoutMs,
        transport:
          providedOfficialTransport ??
          (officialConfig.proxyURL
            ? proxyTransport(officialConfig.proxyURL)
            : fetchTransport(fetchImplementation)),
      })
    : null
  const officialAccounts = officialClient
    ? new OfficialAccountService(
        repository,
        new CredentialCipher(config.credentialActiveKeyId, config.credentialKeys),
        officialClient,
      )
    : null
  const officialBindings =
    officialAccounts && officialClient
      ? new OfficialBindingService(repository, officialAccounts, officialClient, (sourceURL) =>
          resolveCredentialDependency(sourceURL, repository, catalog),
        )
      : null
  const server = Fastify({
    bodyLimit: 16 * 1024,
    logger: logger
      ? {
          redact: {
            censor: "[Redacted]",
            paths: ["req.headers.authorization", "req.query.url"],
          },
          serializers: {
            req: (request) => ({
              method: request.method,
              url: redactPublicFeedURL(request.url),
              remoteAddress: request.ip,
            }),
          },
        }
      : false,
    // Forwarding headers are only believed from these proxies, so a client that reaches the
    // supplier directly cannot choose the address it is rate limited by.
    trustProxy: config.trustProxy.length > 0 ? config.trustProxy.join(",") : false,
    requestTimeout:
      Math.max(
        config.rssHubFetchTimeoutMs,
        config.pageFetchTimeoutMs,
        13 * config.webListFetchTimeoutMs + WEB_LIST_DETAIL_BUDGET_MS,
      ) + 5_000,
  })
  const responseCache =
    providedResponseCache ??
    (config.redisURL
      ? await RedisSourceResponseCache.connect(
          config.redisURL,
          config.redisConnectTimeoutMs,
          config.rssHubFetchMaxBytes,
        )
      : new MemorySourceResponseCache())
  const requestCoalescer = new SourceRequestCoalescer()
  const scalingTelemetry = new SourceScalingTelemetry()
  const baseURL = new URL(`${config.rssHubBaseURL}/`)
  let lastWebListCycleAt: string | null = null
  let lastPageChangeCycleAt: string | null = null

  const stopWebListScheduler = startWebListScheduler({
    service: webLists,
    pollIntervalMs: config.webListSchedulerPollIntervalMs,
    onCycle: (result) => {
      lastWebListCycleAt = new Date().toISOString()
      if (result.checked > 0) server.log.info(result, "Web list cycle completed")
    },
  })
  const stopPageChangeScheduler = startPageChangeScheduler({
    onCycle: (result) => {
      lastPageChangeCycleAt = new Date().toISOString()
      if (result.checked > 0) server.log.info(result, "Page change cycle completed")
    },
    pollIntervalMs: config.pageSchedulerPollIntervalMs,
    service: pageChanges,
  })
  server.addHook("onClose", async () => {
    await stopPageChangeScheduler()
    await stopWebListScheduler()
    await responseCache.close()
    await repository.close()
  })

  const upstreamURL = async (input: string, preResolved?: ResolvedRssHubSource) => {
    const resolved = preResolved ?? (await registry.resolve(input))
    const { source } = resolved
    const target = new URL(source.routePath.replace(/^\//, ""), baseURL)
    target.search = source.search
    for (const [parameter, value] of Object.entries(resolved.secretQuery)) {
      target.searchParams.set(parameter, value)
    }
    if (config.rssHubAccessKey) target.searchParams.set("key", config.rssHubAccessKey)
    const diagnosticURL = new URL(target)
    diagnosticURL.searchParams.delete("key")
    for (const parameter of Object.keys(resolved.secretQuery)) {
      diagnosticURL.searchParams.delete(parameter)
    }
    return { resolved, target, diagnosticURL: diagnosticURL.toString() }
  }

  const fetchUpstream = async (target: URL, headers: Headers) => {
    let currentURL = target
    const signal = AbortSignal.timeout(config.rssHubFetchTimeoutMs)
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      const response = await fetchImplementation(currentURL, {
        headers,
        redirect: "manual",
        signal,
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

  const scalingOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof SourceScalingError) throw error
      throw new SourceScalingError(
        "source_scaling_unavailable",
        "RSSHub scaling coordination is unavailable",
        503,
        1,
      )
    }
  }

  const withScalingCapacity = async <T>(
    policyKey: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const leaseMs = config.rssHubFetchTimeoutMs + 5_000
    const globalLease = await scalingOperation(() =>
      responseCache.acquireLease("global", config.rssHubGlobalConcurrency, leaseMs),
    )
    if (!globalLease) {
      scalingTelemetry.recordConcurrencyRejection()
      throw new SourceScalingError(
        "source_capacity_exceeded",
        "Global RSSHub request capacity is busy",
        503,
        1,
      )
    }
    let routeLease: string | null = null
    try {
      routeLease = await scalingOperation(() =>
        responseCache.acquireLease(policyKey, config.rssHubRouteConcurrency, leaseMs),
      )
      if (!routeLease) {
        scalingTelemetry.recordConcurrencyRejection()
        throw new SourceScalingError(
          "source_route_busy",
          "RSSHub route concurrency limit exceeded",
          503,
          1,
        )
      }
      const rateLimit = await scalingOperation(() =>
        responseCache.consumeRateLimit(
          policyKey,
          config.rssHubRouteRateLimitMax,
          config.rssHubRouteRateLimitWindowSeconds,
        ),
      )
      if (!rateLimit.allowed) {
        scalingTelemetry.recordRateLimit()
        throw new SourceScalingError(
          "source_rate_limited",
          "RSSHub route request limit exceeded",
          429,
          rateLimit.retryAfterSeconds,
        )
      }
      const endRequest = scalingTelemetry.beginRequest()
      try {
        return await operation()
      } finally {
        endRequest()
      }
    } finally {
      await scalingOperation(() =>
        Promise.all([
          routeLease ? responseCache.releaseLease(policyKey, routeLease) : Promise.resolve(),
          responseCache.releaseLease("global", globalLease),
        ]).then(() => undefined),
      )
    }
  }

  // `preResolved` lets the owner test a template that registry resolution would not accept yet,
  // such as a disabled catalog route.
  const testRoute = async (sourceURL: string, preResolved?: ResolvedRssHubSource) => {
    try {
      const { resolved, target, diagnosticURL } = await upstreamURL(sourceURL, preResolved)
      return await withScalingCapacity(resolved.policyKey, async () => {
        const response = await fetchUpstream(
          target,
          new Headers({
            accept:
              "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
            "user-agent": "Folo-Feed-Supplier/1.0 (+self-hosted RSSHub)",
          }),
        )
        if (!response.ok) {
          throw new SourceRegistryError(
            "rsshub_request_failed",
            `RSSHub request failed with HTTP ${response.status}`,
            502,
          )
        }
        const body = await boundedBody(response, config.rssHubFetchMaxBytes)
        return {
          contentBytes: Buffer.byteLength(body),
          contentType: response.headers.get("content-type"),
          upstreamStatus: response.status,
          upstreamURL: diagnosticURL,
        }
      })
    } catch (error) {
      if (error instanceof SourceRegistryError || error instanceof SourceScalingError) throw error
      throw new SourceRegistryError("rsshub_request_failed", safeUpstreamErrorMessage(error), 502)
    }
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
    const [persistenceReady, upstreamReady] = await Promise.all([
      repository.isReady(),
      probeUpstream(),
    ])
    if (persistenceReady && upstreamReady && responseCache.isReady()) return { status: "ready" }
    return reply.status(503).send({ status: "unavailable" })
  })

  server.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url === "/health" || request.routeOptions.url === "/ready") return
    // Public subscription links carry their own capability token (ADR-0033).
    if (request.routeOptions.url === PUBLIC_FEED_ROUTE) return
    const authorization = request.headers.authorization
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined
    const url = request.routeOptions.url
    // Each prefix accepts exactly one token; the routes under /v1/manage/ only exist when a
    // management token is configured.
    const expectedToken = url?.startsWith("/v1/admin/")
      ? config.adminToken
      : url?.startsWith("/v1/manage/")
        ? config.managementToken
        : config.internalToken
    if (!expectedToken || !matchesSecret(token, expectedToken)) {
      return reply
        .header("www-authenticate", 'Bearer realm="folo-feed-supplier"')
        .status(401)
        .send({ code: "unauthorized", message: "Supplier authentication required" })
    }
  })

  server.get("/v1/providers", async () => {
    const [persistenceReady, upstreamReady] = await Promise.all([
      repository.isReady(),
      probeUpstream(),
    ])
    const [managedRouteCount, catalogRouteCount] = persistenceReady
      ? await Promise.all([
          registry.countManagedRoutes().catch(() => 0),
          catalog
            .listAdminRoutes()
            .then((routes) => routes.length)
            .catch(() => 0),
        ])
      : [0, 0]
    const scalingReady = responseCache.isReady()
    const ready = persistenceReady && upstreamReady && scalingReady
    const scalingSnapshot = scalingTelemetry.snapshot()
    const webListCounts = persistenceReady
      ? await repository
          .countWebListSources(new Date().toISOString())
          .catch(() => ({ due: 0, enabled: 0, total: 0 }))
      : { due: 0, enabled: 0, total: 0 }
    const pageCounts = persistenceReady
      ? await repository.countPageChangeSources(new Date().toISOString()).catch(() => ({
          due: 0,
          enabled: 0,
          total: 0,
        }))
      : { due: 0, enabled: 0, total: 0 }
    return {
      providers: [
        {
          ...scalingSnapshot,
          cacheStatus: scalingReady ? ("ready" as const) : ("unavailable" as const),
          configured: true,
          catalogRouteCount,
          id: "rsshub" as const,
          managedRouteCount,
          message: ready
            ? null
            : !persistenceReady
              ? "Source registry persistence is unavailable"
              : !upstreamReady
                ? "Configured RSSHub instance is unavailable"
                : "Source scaling coordination is unavailable",
          persistenceStatus: persistenceReady ? ("ready" as const) : ("unavailable" as const),
          registryMode: registry.mode,
          status: ready ? ("ready" as const) : ("unavailable" as const),
        },
        {
          configured: true,
          dueSourceCount: pageCounts.due,
          enabledSourceCount: pageCounts.enabled,
          id: "page_change" as const,
          lastCycleAt: lastPageChangeCycleAt,
          message: persistenceReady ? null : "Source registry persistence is unavailable",
          persistenceStatus: persistenceReady ? ("ready" as const) : ("unavailable" as const),
          status: persistenceReady ? ("ready" as const) : ("unavailable" as const),
        },
        {
          configured: true,
          dueSourceCount: webListCounts.due,
          enabledSourceCount: webListCounts.enabled,
          id: "web_list" as const,
          lastCycleAt: lastWebListCycleAt,
          message: persistenceReady ? null : "Source registry persistence is unavailable",
          persistenceStatus: persistenceReady ? ("ready" as const) : ("unavailable" as const),
          status: persistenceReady ? ("ready" as const) : ("unavailable" as const),
        },
        // Only reported when configured: a core older than ADR-0034 rejects unknown providers.
        ...(officialAccounts
          ? [
              {
                ...(await officialAccounts.providerHealth()),
                ...(await repository
                  .countOfficialBindings()
                  .then((counts) => ({
                    activeBindingCount: counts.active,
                    failedBindingCount: counts.failed,
                  }))
                  .catch(() => ({}))),
              },
            ]
          : []),
      ],
    }
  })

  const catalogParameters = z
    .object({
      parameters: z.record(
        z.string().min(1).max(64),
        z.union([z.boolean(), z.number().safe(), z.string().max(512)]),
      ),
    })
    .strict()

  const sendCatalogError = (error: unknown, reply: FastifyReply) => {
    if (error instanceof SourceScalingError) {
      if (error.retryAfterSeconds) reply.header("retry-after", error.retryAfterSeconds)
      return reply.status(error.statusCode).send({ code: error.code, message: error.message })
    }
    if (error instanceof SourceRegistryError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message })
    }
    throw error
  }

  server.get("/v1/catalog/routes", async () => ({ routes: await catalog.listPublicRoutes() }))

  server.post<{ Params: { routeId: string } }>(
    "/v1/catalog/routes/:routeId/render",
    async (request, reply) => {
      const parsed = catalogParameters.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          code: "invalid_request",
          message: parsed.error.issues[0]?.message ?? "Request is invalid",
        })
      }
      try {
        return await catalog.render(request.params.routeId, parsed.data.parameters)
      } catch (error) {
        return sendCatalogError(error, reply)
      }
    },
  )

  server.post<{ Params: { routeId: string } }>(
    "/v1/catalog/routes/:routeId/test",
    async (request, reply) => {
      const parsed = catalogParameters.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          code: "invalid_request",
          message: parsed.error.issues[0]?.message ?? "Request is invalid",
        })
      }
      let logicalURL: string
      try {
        logicalURL = (await catalog.render(request.params.routeId, parsed.data.parameters))
          .logicalURL
        const result = await testRoute(logicalURL)
        await catalog.recordTest(request.params.routeId, "feed-supplier-internal", true)
        return { ...result, logicalURL }
      } catch (error) {
        await catalog.recordTest(request.params.routeId, "feed-supplier-internal", false)
        return sendCatalogError(error, reply)
      }
    },
  )

  /** Read path for official bindings: cached and rate limited separately from self-hosted RSSHub. */
  const serveOfficialFeed = async (
    request: FastifyRequest,
    reply: FastifyReply,
    binding: OfficialAcquisitionBinding,
  ) => {
    if (!officialBindings || !officialConfig) throw new Error("Official acquisition is disabled")
    const cacheKey = `official:${binding.sourceURL}`
    const upstreamDiagnostic = `${officialConfig.apiURL}/entries?feedId=${encodeURIComponent(binding.externalFeedId ?? "")}`
    const send = (document: { body: string; etag: string }, cacheStatus: "HIT" | "MISS") => {
      reply
        .header("x-folo-cache", cacheStatus)
        .header("x-folo-acquisition-provider", "folo_official")
        .header("x-folo-upstream-url", upstreamDiagnostic)
        .header("content-type", "application/rss+xml; charset=utf-8")
        .header("etag", document.etag)
      if (request.headers["if-none-match"] === document.etag) return reply.status(304).send()
      return reply.status(200).send(document.body)
    }
    try {
      const cached = await scalingOperation(() => responseCache.getResponse(cacheKey))
      if (cached?.etag) {
        scalingTelemetry.recordCacheHit()
        return send({ body: cached.body, etag: cached.etag }, "HIT")
      }
      scalingTelemetry.recordCacheMiss()
      const { coalesced, value: document } = await requestCoalescer.run(cacheKey, async () => {
        const rateLimit = await scalingOperation(() =>
          responseCache.consumeRateLimit(
            "official",
            officialConfig.rateLimitMax,
            officialConfig.rateLimitWindowSeconds,
          ),
        )
        if (!rateLimit.allowed) {
          scalingTelemetry.recordRateLimit()
          throw new SourceScalingError(
            "source_rate_limited",
            "Official API request limit exceeded",
            429,
            rateLimit.retryAfterSeconds,
          )
        }
        const lease = await scalingOperation(() =>
          responseCache.acquireLease(
            "official",
            officialConfig.concurrency,
            officialConfig.fetchTimeoutMs + 1_000,
          ),
        )
        if (!lease) {
          scalingTelemetry.recordConcurrencyRejection()
          throw new SourceScalingError(
            "source_route_busy",
            "Official API concurrency limit exceeded",
            503,
            1,
          )
        }
        const endRequest = scalingTelemetry.beginRequest()
        try {
          return await officialBindings.readFeed(binding, officialConfig.entryLimit)
        } finally {
          endRequest()
          await scalingOperation(() => responseCache.releaseLease("official", lease))
        }
      })
      if (coalesced) {
        scalingTelemetry.recordCoalescedRequest()
        reply.header("x-folo-coalesced", "true")
      }
      await scalingOperation(() =>
        responseCache.setResponse(
          cacheKey,
          {
            body: document.body,
            contentType: "application/rss+xml; charset=utf-8",
            etag: document.etag,
            lastModified: null,
            upstreamURL: upstreamDiagnostic,
          },
          officialConfig.cacheTTLSeconds,
        ),
      )
      return send(document, "MISS")
    } catch (error) {
      if (error instanceof SourceScalingError) {
        if (error.retryAfterSeconds) reply.header("retry-after", error.retryAfterSeconds)
        return reply.status(error.statusCode).send({ code: error.code, message: error.message })
      }
      if (error instanceof OfficialAccountError) {
        // The core sees a clear code and backs off; a rejected session needs the owner.
        const status =
          error.code === "official_rate_limited"
            ? 429
            : error.code === "official_account_not_linked" || error.code === "official_auth_invalid"
              ? 503
              : 502
        const code =
          error.code === "official_account_not_linked" ? "official_auth_invalid" : error.code
        return reply.status(status).send({ code, message: error.message })
      }
      throw error
    }
  }

  server.get("/v1/feeds/rsshub", async (request, reply) => {
    const query = request.query as Record<string, unknown>
    if (typeof query.url !== "string") {
      return reply.status(400).send({ code: "invalid_source", message: "url is required" })
    }

    // Sources bound to the official account are served from it (ADR-0034); nothing else changes.
    if (officialBindings && officialConfig) {
      let logicalURL: string | null = null
      try {
        logicalURL = parseRssHubSource(query.url).logicalURL
      } catch {
        // Invalid addresses are reported by the regular path below.
      }
      const binding = logicalURL ? await officialBindings.activeBindingFor(logicalURL) : null
      if (binding) return serveOfficialFeed(request, reply, binding)
    }

    let sourceRequest: ReturnType<typeof upstreamURL>
    try {
      sourceRequest = upstreamURL(query.url)
      await sourceRequest
    } catch (error) {
      if (error instanceof SourceRegistryError) {
        return reply.status(error.statusCode).send({ code: error.code, message: error.message })
      }
      return reply.status(400).send({
        code: "invalid_source",
        message: error instanceof Error ? error.message.slice(0, 500) : "Invalid RSSHub source",
      })
    }

    try {
      const { resolved, target, diagnosticURL } = await sourceRequest
      const cached = await scalingOperation(() =>
        responseCache.getResponse(resolved.source.logicalURL),
      )
      const sendCached = (response: CachedRssHubResponse, cacheStatus: "HIT" | "MISS") => {
        reply
          .header("x-folo-cache", cacheStatus)
          .header("x-folo-upstream-url", response.upstreamURL)
        if (response.contentType) reply.header("content-type", response.contentType)
        if (response.etag) reply.header("etag", response.etag)
        if (response.lastModified) reply.header("last-modified", response.lastModified)
        if (
          (response.etag && request.headers["if-none-match"] === response.etag) ||
          (!response.etag &&
            response.lastModified &&
            request.headers["if-modified-since"] === response.lastModified)
        ) {
          return reply.status(304).send()
        }
        return reply.status(200).send(response.body)
      }
      if (cached) {
        scalingTelemetry.recordCacheHit()
        return sendCached(cached, "HIT")
      }
      scalingTelemetry.recordCacheMiss()
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
      const { coalesced, value: upstream } = await requestCoalescer.run(
        [
          resolved.source.logicalURL,
          request.headers["if-none-match"] ?? "",
          request.headers["if-modified-since"] ?? "",
        ].join("\0"),
        () =>
          withScalingCapacity(resolved.policyKey, async () => {
            const response = await fetchUpstream(target, headers)
            return {
              body:
                response.status === 304 || !response.ok
                  ? null
                  : await boundedBody(response, config.rssHubFetchMaxBytes),
              contentType: response.headers.get("content-type"),
              etag: response.headers.get("etag"),
              lastModified: response.headers.get("last-modified"),
              status: response.status,
            }
          }),
      )
      if (coalesced) scalingTelemetry.recordCoalescedRequest()
      reply.header("x-folo-cache", "MISS")
      if (coalesced) reply.header("x-folo-coalesced", "true")
      reply.header("x-folo-upstream-url", diagnosticURL)
      if (upstream.status === 304) {
        if (upstream.etag) reply.header("etag", upstream.etag)
        if (upstream.lastModified) reply.header("last-modified", upstream.lastModified)
        return reply.status(304).send()
      }
      if (upstream.status < 200 || upstream.status >= 300) {
        return reply.status(502).send({
          code: "rsshub_request_failed",
          message: `RSSHub request failed with HTTP ${upstream.status}`,
        })
      }
      if (upstream.contentType) reply.header("content-type", upstream.contentType)
      if (upstream.etag) reply.header("etag", upstream.etag)
      if (upstream.lastModified) reply.header("last-modified", upstream.lastModified)
      const cachedResponse: CachedRssHubResponse = {
        body: upstream.body ?? "",
        contentType: upstream.contentType,
        etag: upstream.etag,
        lastModified: upstream.lastModified,
        upstreamURL: diagnosticURL,
      }
      await scalingOperation(() =>
        responseCache.setResponse(
          resolved.source.logicalURL,
          cachedResponse,
          config.rssHubCacheTTLSeconds,
        ),
      )
      return sendCached(cachedResponse, "MISS")
    } catch (error) {
      if (error instanceof SourceScalingError) {
        if (error.retryAfterSeconds) reply.header("retry-after", error.retryAfterSeconds)
        return reply.status(error.statusCode).send({ code: error.code, message: error.message })
      }
      return reply.status(502).send({
        code: "rsshub_request_failed",
        message: safeUpstreamErrorMessage(error),
      })
    }
  })

  server.get("/v1/feeds/page-change", async (request, reply) => {
    const query = request.query as Record<string, unknown>
    if (typeof query.url !== "string") {
      return reply.status(400).send({ code: "invalid_source", message: "url is required" })
    }
    try {
      const feed = await pageChanges.materializeFeed(query.url)
      reply
        .header("content-type", "application/rss+xml; charset=utf-8")
        .header("etag", feed.etag)
        .header("last-modified", new Date(feed.source.updatedAt).toUTCString())
        .header("x-folo-upstream-url", feed.source.targetURL)
      if (request.headers["if-none-match"] === feed.etag) return reply.status(304).send()
      return reply.status(200).send(feed.body)
    } catch (error) {
      if (error instanceof PageChangeError) {
        return reply.status(error.statusCode).send({ code: error.code, message: error.message })
      }
      return reply.status(400).send({ code: "invalid_source", message: "Invalid page source" })
    }
  })

  server.get("/v1/feeds/web-list", async (request, reply) => {
    const query = request.query as Record<string, unknown>
    if (typeof query.url !== "string") {
      return reply.status(400).send({ code: "invalid_source", message: "url is required" })
    }
    try {
      const feed = await webLists.materializeFeed(query.url)
      reply
        .header("content-type", "application/rss+xml; charset=utf-8")
        .header("etag", feed.etag)
        .header("last-modified", new Date(feed.source.updatedAt).toUTCString())
        .header("x-folo-upstream-url", feed.source.targetURL)
      if (request.headers["if-none-match"] === feed.etag) return reply.status(304).send()
      return reply.status(200).send(feed.body)
    } catch (error) {
      if (error instanceof WebListError) {
        return reply.status(error.statusCode).send({ code: error.code, message: error.message })
      }
      return reply.status(400).send({ code: "invalid_source", message: "Invalid web list source" })
    }
  })

  if (config.managementToken) {
    registerWebListRoutes(server, webLists, "/v1/manage/web-list-sources")
  }

  const publicFeedCipher = new CredentialCipher(config.credentialActiveKeyId, config.credentialKeys)
  registerSourceAdminRoutes({
    webLists,
    catalog,
    pageChanges,
    registry,
    rotatePublicFeedTokens: (actor) =>
      reencryptPublicFeedTokens(repository, publicFeedCipher, actor),
    rotateOfficialAccountToken: officialAccounts
      ? (actor) => reencryptOfficialAccountToken(repository, publicFeedCipher, actor)
      : undefined,
    server,
    testRoute,
  })
  if (officialAccounts) registerOfficialAccountRoutes(server, officialAccounts)
  if (officialBindings) registerOfficialBindingRoutes(server, officialBindings)

  if (config.publicFeedBaseURL) {
    const internalFeedPaths: Record<string, string> = {
      "pagechange:": "/v1/feeds/page-change",
      "rsshub:": "/v1/feeds/rsshub",
      "weblist:": "/v1/feeds/web-list",
    }
    const publicFeeds = new PublicFeedService(
      repository,
      publicFeedCipher,
      config.publicFeedBaseURL,
      // Links are only issued for sources this supplier can serve right now.
      async (sourceURL) => {
        try {
          const url = new URL(sourceURL)
          const protocol = url.protocol
          // Secrets belong in bound credentials; a link must not store or report one.
          const secret = secretQueryParameter(url)
          if (secret) throw new Error(`Bind the secret query parameter ${secret} as a credential`)
          if (protocol === "rsshub:") {
            await registry.resolve(sourceURL)
            // Content fetched through the official account must not be re-published (ADR-0034).
            if (await officialBindings?.hasLiveBinding(parseRssHubSource(sourceURL).logicalURL)) {
              throw new Error("The source is fetched through the official account")
            }
          } else if (protocol === "pagechange:") await pageChanges.materializeFeed(sourceURL)
          else if (protocol === "weblist:") await webLists.materializeFeed(sourceURL)
          else throw new Error("Unsupported source address")
        } catch (error) {
          throw new PublicFeedError(
            "invalid_source",
            error instanceof Error ? error.message.slice(0, 300) : "Invalid source",
            400,
          )
        }
      },
      (sourceURL) => resolveCredentialDependency(sourceURL, repository, catalog),
    )
    registerPublicFeedAdminRoutes(server, publicFeeds)
    registerPublicFeedRoute(server, publicFeeds, async (sourceURL, conditional) => {
      const path = internalFeedPaths[new URL(sourceURL).protocol]
      if (!path) return { body: "", headers: {}, statusCode: 404 }
      // Served through the internal route so caching, coalescing and limits stay identical.
      const response = await server.inject({
        method: "GET",
        url: `${path}?url=${encodeURIComponent(sourceURL)}`,
        headers: {
          authorization: `Bearer ${config.internalToken}`,
          ...(conditional.ifNoneMatch ? { "if-none-match": conditional.ifNoneMatch } : {}),
          ...(conditional.ifModifiedSince
            ? { "if-modified-since": conditional.ifModifiedSince }
            : {}),
        },
      })
      return { body: response.body, headers: response.headers, statusCode: response.statusCode }
    })
  }

  await server.ready()
  return server
}
