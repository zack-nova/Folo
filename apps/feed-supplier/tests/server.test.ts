import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import { PageFetcher } from "../src/page-fetcher"
import { buildFeedSupplier } from "../src/server"
import { MemorySourceResponseCache } from "../src/source-scaling"

const config = loadFeedSupplierConfig({
  INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
  NODE_ENV: "test",
  RSSHUB_ACCESS_KEY: "rsshub-access-key-11111111111111111111",
  RSSHUB_BASE_URL: "http://rsshub:1200",
})

describe("feed supplier", () => {
  it("serves repeated logical routes from the bounded source cache", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<rss><channel><title>Cached</title></channel></rss>", {
        headers: {
          "content-type": "application/rss+xml",
          etag: '"cached-v1"',
          "last-modified": "Wed, 20 Aug 2026 00:00:00 GMT",
        },
      }),
    )
    const server = await buildFeedSupplier({ config, fetchImplementation })
    const request = {
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET" as const,
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Fcached",
    }

    const first = await server.inject(request)
    const second = await server.inject(request)

    expect(first.statusCode).toBe(200)
    expect(first.headers["x-folo-cache"]).toBe("MISS")
    expect(second.statusCode).toBe(200)
    expect(second.headers).toMatchObject({
      etag: '"cached-v1"',
      "last-modified": "Wed, 20 Aug 2026 00:00:00 GMT",
      "x-folo-cache": "HIT",
    })
    expect(second.body).toContain("Cached")
    expect(fetchImplementation).toHaveBeenCalledTimes(1)

    const providers = await server.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET",
      url: "/v1/providers",
    })
    expect(providers.json<{ providers: unknown[] }>().providers[0]).toMatchObject({
      activeRequestCount: 0,
      cacheHitCount: 1,
      cacheMissCount: 1,
      cacheStatus: "ready",
      coalescedRequestCount: 0,
      concurrencyRejectedRequestCount: 0,
      id: "rsshub",
      rateLimitedRequestCount: 0,
    })

    await server.close()
  })

  it("coalesces concurrent cache misses for the same logical route", async () => {
    let finishFetch: ((response: Response) => void) | undefined
    const upstream = new Promise<Response>((resolve) => {
      finishFetch = resolve
    })
    const fetchImplementation = vi.fn<typeof fetch>().mockReturnValue(upstream)
    const server = await buildFeedSupplier({ config, fetchImplementation })
    const request = {
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET" as const,
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Fcoalesced",
    }

    const first = server.inject(request)
    const second = server.inject(request)
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1))
    finishFetch?.(
      new Response("<rss><channel><title>Coalesced</title></channel></rss>", {
        headers: { "content-type": "application/rss+xml", etag: '"coalesced-v1"' },
      }),
    )
    const responses = await Promise.all([first, second])

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200])
    expect(responses.map((response) => response.body)).toEqual([
      expect.stringContaining("Coalesced"),
      expect.stringContaining("Coalesced"),
    ])
    expect(fetchImplementation).toHaveBeenCalledTimes(1)

    await server.close()
  })

  it("rate limits repeated upstream attempts per logical route", async () => {
    const limitedConfig = loadFeedSupplierConfig({
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
      RSSHUB_BASE_URL: "http://rsshub:1200",
      RSSHUB_ROUTE_RATE_LIMIT_MAX: "1",
      RSSHUB_ROUTE_RATE_LIMIT_WINDOW_SECONDS: "60",
    })
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("upstream failed", { status: 503 }))
    const server = await buildFeedSupplier({ config: limitedConfig, fetchImplementation })
    const request = {
      headers: { authorization: `Bearer ${limitedConfig.internalToken}` },
      method: "GET" as const,
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Flimited",
    }

    const firstAttempt = await server.inject(request)
    expect(firstAttempt.statusCode, firstAttempt.body).toBe(502)
    const limited = await server.inject(request)

    expect(limited.statusCode).toBe(429)
    expect(limited.headers["retry-after"]).toBe("60")
    expect(limited.json()).toMatchObject({ code: "source_rate_limited" })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)

    await server.close()
  })

  it("isolates concurrent upstream work per logical route", async () => {
    const isolatedConfig = loadFeedSupplierConfig({
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
      RSSHUB_BASE_URL: "http://rsshub:1200",
      RSSHUB_GLOBAL_CONCURRENCY: "4",
      RSSHUB_ROUTE_CONCURRENCY: "1",
    })
    let finishFetch: ((response: Response) => void) | undefined
    const upstream = new Promise<Response>((resolve) => {
      finishFetch = resolve
    })
    const fetchImplementation = vi.fn<typeof fetch>().mockReturnValue(upstream)
    const server = await buildFeedSupplier({ config: isolatedConfig, fetchImplementation })
    const url = "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Fisolated"
    const first = server.inject({
      headers: {
        authorization: `Bearer ${isolatedConfig.internalToken}`,
        "if-none-match": '"first"',
      },
      method: "GET",
      url,
    })
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1))
    const secondPromise = server.inject({
      headers: {
        authorization: `Bearer ${isolatedConfig.internalToken}`,
        "if-none-match": '"second"',
      },
      method: "GET",
      url,
    })
    const earlySecond = await Promise.race([
      secondPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ])
    finishFetch?.(
      new Response("<rss><channel><title>Isolated</title></channel></rss>", {
        headers: { "content-type": "application/rss+xml" },
      }),
    )
    await Promise.all([first, secondPromise])

    expect(earlySecond?.statusCode).toBe(503)
    expect(earlySecond?.json()).toMatchObject({ code: "source_route_busy" })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)

    await server.close()
  })

  it("bounds global upstream concurrency across different routes", async () => {
    const isolatedConfig = loadFeedSupplierConfig({
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
      RSSHUB_BASE_URL: "http://rsshub:1200",
      RSSHUB_GLOBAL_CONCURRENCY: "1",
      RSSHUB_ROUTE_CONCURRENCY: "1",
    })
    let finishFetch: ((response: Response) => void) | undefined
    const upstream = new Promise<Response>((resolve) => {
      finishFetch = resolve
    })
    const fetchImplementation = vi.fn<typeof fetch>().mockReturnValue(upstream)
    const server = await buildFeedSupplier({ config: isolatedConfig, fetchImplementation })
    const first = server.inject({
      headers: { authorization: `Bearer ${isolatedConfig.internalToken}` },
      method: "GET",
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Fglobal-first",
    })
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1))
    const second = await server.inject({
      headers: { authorization: `Bearer ${isolatedConfig.internalToken}` },
      method: "GET",
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Fglobal-second",
    })
    finishFetch?.(
      new Response("<rss><channel><title>Global</title></channel></rss>", {
        headers: { "content-type": "application/rss+xml" },
      }),
    )
    await first

    expect(second.statusCode).toBe(503)
    expect(second.headers["retry-after"]).toBe("1")
    expect(second.json()).toMatchObject({ code: "source_capacity_exceeded" })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)

    await server.close()
  })

  it("fails closed when source scaling coordination is unavailable", async () => {
    class UnavailableSourceScaling extends MemorySourceResponseCache {
      override async getResponse(): Promise<never> {
        throw new Error("coordination unavailable")
      }

      override isReady(): boolean {
        return false
      }
    }

    const server = await buildFeedSupplier({
      config,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(new Response("ok")),
      responseCache: new UnavailableSourceScaling(),
    })

    const ready = await server.inject({ method: "GET", url: "/ready" })
    const feed = await server.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET",
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Funavailable",
    })

    expect(ready.statusCode).toBe(503)
    expect(feed.statusCode).toBe(503)
    expect(feed.headers["retry-after"]).toBe("1")
    expect(feed.json()).toEqual({
      code: "source_scaling_unavailable",
      message: "RSSHub scaling coordination is unavailable",
    })
    await server.close()
  })

  it("authenticates internal requests and keeps the RSSHub key out of diagnostics", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<rss><channel><title>Stars</title></channel></rss>", {
        headers: { "content-type": "application/rss+xml", etag: '"stars-v1"' },
      }),
    )
    const server = await buildFeedSupplier({ config, fetchImplementation })

    const unauthorized = await server.inject({
      method: "GET",
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fgithub%2Fstars%2FDIYgod%2FRSSHub",
    })
    expect(unauthorized.statusCode).toBe(401)

    const response = await server.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET",
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fgithub%2Fstars%2FDIYgod%2FRSSHub",
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers["x-folo-upstream-url"]).toBe(
      "http://rsshub:1200/github/stars/DIYgod/RSSHub",
    )
    expect(response.headers["x-folo-upstream-url"]).not.toContain(config.rssHubAccessKey)
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      new URL(
        "http://rsshub:1200/github/stars/DIYgod/RSSHub?key=rsshub-access-key-11111111111111111111",
      ),
      expect.objectContaining({ redirect: "manual" }),
    )

    await server.close()
  })

  it("uses one overall timeout across RSSHub redirects", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { location: "/example/redirected" },
          status: 302,
        }),
      )
      .mockResolvedValueOnce(
        new Response("<rss><channel><title>Redirected</title></channel></rss>", {
          headers: { "content-type": "application/rss+xml" },
        }),
      )
    const server = await buildFeedSupplier({ config, fetchImplementation })

    const response = await server.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET",
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Foriginal",
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(fetchImplementation.mock.calls[0]?.[1]?.signal).toBe(
      fetchImplementation.mock.calls[1]?.[1]?.signal,
    )
    await server.close()
  })

  it("rejects user-supplied access keys", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const server = await buildFeedSupplier({ config, fetchImplementation })
    const response = await server.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET",
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fgithub%2Fstars%2Fexample%2Frepo%3Fkey%3Dleak",
    })

    expect(response.statusCode).toBe(400)
    expect(fetchImplementation).not.toHaveBeenCalled()
    await server.close()
  })

  it("separates page source administration from materialized feed reads", async () => {
    const pageFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<html><head><title>Price</title></head><main>$42</main></html>", {
        headers: { "content-type": "text/html", etag: '"price-42"' },
      }),
    )
    const pageFetcher = new PageFetcher({
      fetchImplementation: pageFetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      maxBytes: 1024 * 1024,
      maxContentBytes: 256 * 1024,
      timeoutMs: 5_000,
    })
    const server = await buildFeedSupplier({ config, pageFetcher })
    const internalHeaders = { authorization: `Bearer ${config.internalToken}` }
    const adminHeaders = { authorization: `Bearer ${config.adminToken}` }

    const denied = await server.inject({
      headers: internalHeaders,
      method: "GET",
      url: "/v1/admin/page-sources",
    })
    expect(denied.statusCode).toBe(401)

    const created = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        contentSelector: "main",
        name: "Public price",
        targetURL: "https://example.com/price",
      },
      url: "/v1/admin/page-sources",
    })
    expect(created.statusCode).toBe(201)
    const source = created.json<{ source: { feedURL: string; id: string } }>().source

    const checked = await server.inject({
      headers: adminHeaders,
      method: "POST",
      url: `/v1/admin/page-sources/${source.id}/check`,
    })
    expect(checked.json()).toMatchObject({ status: "initial_published" })

    const feedURL = `/v1/feeds/page-change?url=${encodeURIComponent(source.feedURL)}`
    const feed = await server.inject({ headers: internalHeaders, method: "GET", url: feedURL })
    expect(feed.statusCode).toBe(200)
    expect(feed.headers["content-type"]).toContain("application/rss+xml")
    expect(feed.body).toContain("$42")
    const notModified = await server.inject({
      headers: { ...internalHeaders, "if-none-match": feed.headers.etag! },
      method: "GET",
      url: feedURL,
    })
    expect(notModified.statusCode).toBe(304)

    const forbiddenSecret = await server.inject({
      headers: adminHeaders,
      method: "PATCH",
      payload: { targetURL: "https://example.com/price?token=must-not-leak" },
      url: `/v1/admin/page-sources/${source.id}`,
    })
    expect(forbiddenSecret.statusCode).toBe(400)
    expect(forbiddenSecret.body).not.toContain("must-not-leak")

    await server.close()
  })
})
