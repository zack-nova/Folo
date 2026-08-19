import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { MemoryDataStore } from "../src/data/memory-store"
import { FeedSupplierFetcher } from "../src/feeds/feed-supplier-fetcher"
import { HttpFeedFetcher } from "../src/feeds/http-fetcher"
import { FeedImporter } from "../src/feeds/importer"
import { RoutingFeedFetcher } from "../src/feeds/routing-fetcher"

const fixturePath = fileURLToPath(new URL("fixtures/phase-one.rss.xml", import.meta.url))

describe("feed supplier fetcher", () => {
  it("uses the internal token for catalog reads, rendering, and connection tests", async () => {
    const supplierFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ routes: [] }))
      .mockResolvedValueOnce(Response.json({ logicalURL: "rsshub://example/releases/folo" }))
      .mockResolvedValueOnce(
        Response.json({
          contentBytes: 128,
          contentType: "application/rss+xml",
          logicalURL: "rsshub://example/releases/folo",
          upstreamStatus: 200,
          upstreamURL: "http://rsshub:1200/example/releases/folo",
        }),
      )
    const fetcher = new FeedSupplierFetcher({
      baseURL: "http://feed-supplier:3001",
      fetchImplementation: supplierFetch,
      token: "internal-feed-supplier-token-000000000000",
    })

    await expect(fetcher.listRoutes()).resolves.toEqual([])
    await expect(fetcher.renderRoute("route-id", { project: "folo" })).resolves.toEqual({
      logicalURL: "rsshub://example/releases/folo",
    })
    await expect(fetcher.testRoute("route-id", { project: "folo" })).resolves.toMatchObject({
      upstreamStatus: 200,
    })
    for (const call of supplierFetch.mock.calls) {
      expect(new Headers(call[1]?.headers).get("authorization")).toBe(
        "Bearer internal-feed-supplier-token-000000000000",
      )
    }
    expect(supplierFetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ parameters: { project: "folo" } }),
    )
  })

  it("rejects catalog payloads that contain supplier management fields", async () => {
    const supplierFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        routes: [
          {
            category: "Development",
            createdAt: "2026-08-19T00:00:00.000Z",
            description: null,
            documentationURL: null,
            enabled: true,
            id: "8bd44f7a-84d2-4b0c-b052-3cdacbfc3919",
            key: "repository-releases",
            parameters: [],
            requiresCredentials: true,
            routePathTemplate: "/github/releases/:owner/:repository",
            secretQueryBindings: {
              token: "99b6390a-d36e-457a-a82a-f5754b69eabc",
            },
            title: "Repository releases",
            updatedAt: "2026-08-19T00:00:00.000Z",
          },
        ],
      }),
    )
    const fetcher = new FeedSupplierFetcher({
      baseURL: "http://feed-supplier:3001",
      fetchImplementation: supplierFetch,
      token: "internal-feed-supplier-token-000000000000",
    })

    await expect(fetcher.listRoutes()).rejects.toThrow("Supplier catalog response is invalid")
  })

  it("preserves source registry persistence status", async () => {
    const supplierFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        providers: [
          {
            activeRequestCount: 2,
            cacheHitCount: 12,
            cacheMissCount: 3,
            cacheStatus: "ready",
            catalogRouteCount: 2,
            coalescedRequestCount: 4,
            configured: true,
            concurrencyRejectedRequestCount: 1,
            id: "rsshub",
            managedRouteCount: 3,
            message: null,
            persistenceStatus: "ready",
            rateLimitedRequestCount: 2,
            registryMode: "managed_only",
            status: "ready",
          },
          {
            configured: true,
            dueSourceCount: 0,
            enabledSourceCount: 1,
            id: "page_change",
            lastCycleAt: "2026-08-19T08:00:00.000Z",
            message: null,
            persistenceStatus: "ready",
            status: "ready",
          },
        ],
      }),
    )
    const fetcher = new FeedSupplierFetcher({
      baseURL: "http://feed-supplier:3001",
      fetchImplementation: supplierFetch,
      token: "internal-feed-supplier-token-000000000000",
    })

    await expect(fetcher.getProviderStatuses()).resolves.toEqual([
      expect.objectContaining({
        activeRequestCount: 2,
        cacheHitCount: 12,
        cacheMissCount: 3,
        cacheStatus: "ready",
        catalogRouteCount: 2,
        coalescedRequestCount: 4,
        concurrencyRejectedRequestCount: 1,
        managedRouteCount: 3,
        persistenceStatus: "ready",
        rateLimitedRequestCount: 2,
        registryMode: "managed_only",
      }),
      expect.objectContaining({
        enabledSourceCount: 1,
        id: "page_change",
        persistenceStatus: "ready",
      }),
    ])
  })

  it("routes pagechange:// materialized feeds without using the ordinary RSS fetcher", async () => {
    const feedXML = await readFile(fixturePath, "utf8")
    const supplierFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(feedXML, {
        headers: {
          "content-type": "application/rss+xml",
          "x-folo-upstream-url": "https://example.com/status",
        },
      }),
    )
    const standardFetch = vi.fn<typeof fetch>()
    const router = new RoutingFeedFetcher(
      new HttpFeedFetcher({
        fetchImplementation: standardFetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
      new FeedSupplierFetcher({
        baseURL: "http://feed-supplier:3001",
        fetchImplementation: supplierFetch,
        token: "internal-feed-supplier-token-000000000000",
      }),
    )
    const sourceURL = "pagechange://8bd44f7a-84d2-4b0c-b052-3cdacbfc3919"

    const importer = new FeedImporter(new MemoryDataStore(), router)
    const imported = await importer.subscribe("owner", { url: sourceURL })

    expect(imported.feed.url).toBe(sourceURL)
    expect(imported.entries.length).toBeGreaterThan(0)
    expect(router.providerFor(sourceURL)).toBe("feed_supplier")
    expect(standardFetch).not.toHaveBeenCalled()
    expect(String(supplierFetch.mock.calls[0]?.[0])).toContain("/v1/feeds/page-change?url=")
  })

  it("routes rsshub:// sources through the authenticated supplier and preserves logical identity", async () => {
    const feedXML = await readFile(fixturePath, "utf8")
    const supplierFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(feedXML, {
        headers: {
          "content-type": "application/rss+xml",
          etag: '"rsshub-v1"',
          "x-folo-upstream-url": "http://rsshub:1200/github/stars/DIYgod/RSSHub",
        },
      }),
    )
    const standardFetch = vi.fn<typeof fetch>()
    const router = new RoutingFeedFetcher(
      new HttpFeedFetcher({
        fetchImplementation: standardFetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
      new FeedSupplierFetcher({
        baseURL: "http://feed-supplier:3001",
        fetchImplementation: supplierFetch,
        token: "internal-feed-supplier-token-000000000000",
      }),
    )
    const importer = new FeedImporter(new MemoryDataStore(), router)
    const sourceURL = "rsshub://github/stars/DIYgod/RSSHub"

    const imported = await importer.subscribe("owner", { url: sourceURL })

    expect(imported.feed.url).toBe(sourceURL)
    expect(importer.providerFor(imported.feed.url)).toBe("feed_supplier")
    expect(standardFetch).not.toHaveBeenCalled()
    expect(supplierFetch).toHaveBeenCalledOnce()
    const [requestURL, requestOptions] = supplierFetch.mock.calls[0]!
    expect(String(requestURL)).toContain("http://feed-supplier:3001/v1/feeds/rsshub?url=")
    expect(new Headers(requestOptions?.headers).get("authorization")).toBe(
      "Bearer internal-feed-supplier-token-000000000000",
    )
  })

  it("keeps ordinary feeds on the SSRF-hardened standard fetcher", async () => {
    const feedXML = await readFile(fixturePath, "utf8")
    const standardFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(feedXML, { headers: { "content-type": "application/rss+xml" } }),
      )
    const supplierFetch = vi.fn<typeof fetch>()
    const router = new RoutingFeedFetcher(
      new HttpFeedFetcher({
        fetchImplementation: standardFetch,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
      new FeedSupplierFetcher({
        baseURL: "http://feed-supplier:3001",
        fetchImplementation: supplierFetch,
        token: "internal-feed-supplier-token-000000000000",
      }),
    )

    await router.fetch("https://feeds.example.com/rss.xml")

    expect(router.providerFor("https://feeds.example.com/rss.xml")).toBe("standard_rss")
    expect(standardFetch).toHaveBeenCalledOnce()
    expect(supplierFetch).not.toHaveBeenCalled()
  })
})
