import { describe, expect, it, vi } from "vitest"

import { createSourceCatalogClient } from "./api"

describe("source catalog client", () => {
  it("uses owner-authenticated core endpoints without supplier credentials", async () => {
    const request = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ code: 0, data: { routes: [] } }))
      .mockResolvedValueOnce(
        Response.json({ code: 0, data: { logicalURL: "rsshub://example/releases/folo" } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          code: 0,
          data: {
            contentBytes: 128,
            contentType: "application/rss+xml",
            logicalURL: "rsshub://example/releases/folo",
            upstreamStatus: 200,
            upstreamURL: "http://rsshub:1200/example/releases/folo",
          },
        }),
      )
    const client = createSourceCatalogClient(request)

    await expect(client.list()).resolves.toEqual({ routes: [] })
    await client.render("route-id", { project: "folo" })
    await client.test("route-id", { project: "folo" })

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/api/extensions/sources/catalog",
      "/api/extensions/sources/catalog/route-id/render",
      "/api/extensions/sources/catalog/route-id/test",
    ])
    for (const [, init] of request.mock.calls.slice(1)) {
      expect(init?.headers).toEqual({ "content-type": "application/json" })
      expect(init?.body).toBe(JSON.stringify({ parameters: { project: "folo" } }))
      expect(new Headers(init?.headers).has("authorization")).toBe(false)
    }
  })
})
