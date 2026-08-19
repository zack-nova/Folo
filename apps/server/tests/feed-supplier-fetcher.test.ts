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
  it("preserves source registry persistence status", async () => {
    const supplierFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        providers: [
          {
            configured: true,
            id: "rsshub",
            managedRouteCount: 3,
            message: null,
            persistenceStatus: "ready",
            registryMode: "managed_only",
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
        managedRouteCount: 3,
        persistenceStatus: "ready",
        registryMode: "managed_only",
      }),
    ])
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
