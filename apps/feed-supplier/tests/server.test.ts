import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import { PageFetcher } from "../src/page-fetcher"
import { buildFeedSupplier } from "../src/server"

const config = loadFeedSupplierConfig({
  INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
  NODE_ENV: "test",
  RSSHUB_ACCESS_KEY: "rsshub-access-key-11111111111111111111",
  RSSHUB_BASE_URL: "http://rsshub:1200",
})

describe("feed supplier", () => {
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
