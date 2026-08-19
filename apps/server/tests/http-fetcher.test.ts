import { describe, expect, it, vi } from "vitest"

import { HttpFeedFetcher } from "../src/feeds/http-fetcher"

describe("HTTP feed fetcher", () => {
  it("sends conditional validators and returns a body-free 304 result", async () => {
    const fetchImplementation = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"feed-v1"')
      expect(new Headers(init?.headers).get("if-modified-since")).toBe(
        "Tue, 18 Aug 2026 00:00:00 GMT",
      )
      return new Response(null, {
        headers: { etag: '"feed-v1"' },
        status: 304,
      })
    })
    const fetcher = new HttpFeedFetcher({
      fetchImplementation: fetchImplementation as typeof fetch,
      lookup: async () => [{ address: "203.0.113.10", family: 4 }],
    })

    const result = await fetcher.fetch("https://feeds.example.com/rss.xml", {
      etag: '"feed-v1"',
      lastModified: "Tue, 18 Aug 2026 00:00:00 GMT",
    })

    expect(result).toMatchObject({ body: "", notModified: true, status: 304 })
  })
})
