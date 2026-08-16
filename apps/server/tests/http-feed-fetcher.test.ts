import { describe, expect, it, vi } from "vitest"

import { HttpFeedFetcher } from "../src/feeds/http-fetcher"

describe("HTTP feed fetcher", () => {
  it("rejects private network targets before issuing a request", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const fetcher = new HttpFeedFetcher({
      allowPrivateAddresses: false,
      fetchImplementation,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    })

    await expect(fetcher.fetch("http://localhost/private.xml")).rejects.toThrow(
      "private network address",
    )
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("fetches a bounded public RSS response", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<rss><channel><title>Public</title></channel></rss>", {
        status: 200,
        headers: {
          "content-type": "application/rss+xml",
          etag: '"public-feed"',
        },
      }),
    )
    const fetcher = new HttpFeedFetcher({
      allowPrivateAddresses: false,
      fetchImplementation,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      maxBytes: 1024,
    })

    await expect(fetcher.fetch("https://feeds.example.com/rss.xml")).resolves.toMatchObject({
      contentType: "application/rss+xml",
      etag: '"public-feed"',
      url: "https://feeds.example.com/rss.xml",
    })
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })
})
