import { randomUUID } from "node:crypto"

import { createClient } from "@redis/client"
import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import { buildFeedSupplier } from "../src/server"
import { sourceCacheKey } from "../src/source-scaling"

const redisURL = process.env.TEST_FEED_SUPPLIER_REDIS_URL

describe.skipIf(!redisURL)("Redis source scaling", () => {
  it("discards cached bodies that exceed the configured fetch bound", async () => {
    const logicalURL = `rsshub://example/oversized-${randomUUID()}`
    const redis = createClient({ url: redisURL })
    redis.on("error", () => {})
    await redis.connect()
    await redis.set(
      `folo:feed-supplier:v1:response:${sourceCacheKey(logicalURL)}`,
      JSON.stringify({
        body: "x".repeat(1_025),
        contentType: "application/rss+xml",
        etag: null,
        lastModified: null,
        upstreamURL: "http://rsshub:1200/example/oversized",
      }),
      { EX: 30 },
    )
    redis.destroy()
    const config = loadFeedSupplierConfig({
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
      REDIS_URL: redisURL,
      RSSHUB_BASE_URL: "http://rsshub:1200",
      RSSHUB_FETCH_MAX_BYTES: "1024",
    })
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<rss><channel><title>Bounded</title></channel></rss>", {
        headers: { "content-type": "application/rss+xml" },
      }),
    )
    const server = await buildFeedSupplier({ config, fetchImplementation: upstream })

    const response = await server.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET",
      url: `/v1/feeds/rsshub?url=${encodeURIComponent(logicalURL)}`,
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers["x-folo-cache"]).toBe("MISS")
    expect(upstream).toHaveBeenCalledTimes(1)
    await server.close()
  })

  it("shares a credential-free response cache across supplier processes", async () => {
    const logicalURL = `rsshub://example/redis-${randomUUID()}`
    const config = loadFeedSupplierConfig({
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
      REDIS_URL: redisURL,
      RSSHUB_BASE_URL: "http://rsshub:1200",
      RSSHUB_CACHE_TTL_SECONDS: "30",
    })
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<rss><channel><title>Redis cached</title></channel></rss>", {
        headers: { "content-type": "application/rss+xml", etag: '"redis-v1"' },
      }),
    )
    const firstServer = await buildFeedSupplier({ config, fetchImplementation: upstream })
    const request = {
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET" as const,
      url: `/v1/feeds/rsshub?url=${encodeURIComponent(logicalURL)}`,
    }

    expect((await firstServer.inject(request)).headers["x-folo-cache"]).toBe("MISS")
    await firstServer.close()

    const secondUpstream = vi.fn<typeof fetch>()
    const secondServer = await buildFeedSupplier({
      config,
      fetchImplementation: secondUpstream,
    })
    const cached = await secondServer.inject(request)

    expect(cached.statusCode, cached.body).toBe(200)
    expect(cached.headers["x-folo-cache"]).toBe("HIT")
    expect(cached.body).toContain("Redis cached")
    expect(secondUpstream).not.toHaveBeenCalled()

    await secondServer.close()
  })

  it("shares route rate limits across supplier processes", async () => {
    const logicalURL = `rsshub://example/rate-${randomUUID()}`
    const config = loadFeedSupplierConfig({
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
      REDIS_URL: redisURL,
      RSSHUB_BASE_URL: "http://rsshub:1200",
      RSSHUB_ROUTE_RATE_LIMIT_MAX: "1",
      RSSHUB_ROUTE_RATE_LIMIT_WINDOW_SECONDS: "60",
    })
    const request = {
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET" as const,
      url: `/v1/feeds/rsshub?url=${encodeURIComponent(logicalURL)}`,
    }
    const firstServer = await buildFeedSupplier({
      config,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("failed", { status: 503 })),
    })
    expect((await firstServer.inject(request)).statusCode).toBe(502)
    await firstServer.close()

    const secondUpstream = vi.fn<typeof fetch>()
    const secondServer = await buildFeedSupplier({
      config,
      fetchImplementation: secondUpstream,
    })
    const limited = await secondServer.inject(request)

    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ code: "source_rate_limited" })
    expect(secondUpstream).not.toHaveBeenCalled()

    await secondServer.close()
  })

  it("shares global concurrency leases across supplier processes", async () => {
    const suffix = randomUUID()
    const config = loadFeedSupplierConfig({
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
      REDIS_URL: redisURL,
      RSSHUB_BASE_URL: "http://rsshub:1200",
      RSSHUB_GLOBAL_CONCURRENCY: "1",
    })
    let finishFetch: ((response: Response) => void) | undefined
    const upstream = new Promise<Response>((resolve) => {
      finishFetch = resolve
    })
    const firstUpstream = vi.fn<typeof fetch>().mockReturnValue(upstream)
    const firstServer = await buildFeedSupplier({ config, fetchImplementation: firstUpstream })
    const first = firstServer.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET",
      url: `/v1/feeds/rsshub?url=${encodeURIComponent(`rsshub://example/lease-first-${suffix}`)}`,
    })
    await vi.waitFor(() => expect(firstUpstream).toHaveBeenCalledTimes(1))

    const secondUpstream = vi.fn<typeof fetch>()
    const secondServer = await buildFeedSupplier({
      config,
      fetchImplementation: secondUpstream,
    })
    const rejected = await secondServer.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET",
      url: `/v1/feeds/rsshub?url=${encodeURIComponent(`rsshub://example/lease-second-${suffix}`)}`,
    })
    finishFetch?.(
      new Response("<rss><channel><title>Lease</title></channel></rss>", {
        headers: { "content-type": "application/rss+xml" },
      }),
    )
    await first

    expect(rejected.statusCode).toBe(503)
    expect(rejected.json()).toMatchObject({ code: "source_capacity_exceeded" })
    expect(secondUpstream).not.toHaveBeenCalled()

    await Promise.all([firstServer.close(), secondServer.close()])
  })
})
