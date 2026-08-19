import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
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
})
