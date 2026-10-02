import { describe, expect, it, vi } from "vitest"

import { createWebListSourcesClient, WebListSourcesAPIError } from "./api"

describe("web list client", () => {
  it("uses owner-session endpoints, encoded IDs, and exact request bodies", async () => {
    const request = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async () => Response.json({ code: 0, data: { sources: [] } }))
    const client = createWebListSourcesClient(request)
    const input = { name: "News", targetURL: "https://example.com", format: "html" as const }
    await expect(client.list()).resolves.toEqual({ sources: [] })
    await client.create(input)
    await client.get("a/b")
    await client.update("a/b", { enabled: true })
    await client.delete("a/b")
    await client.test("a/b")
    await client.test("a/b", false)
    await client.check("a/b")
    await client.items("a/b")
    const root = "/api/extensions/sources/web-lists"
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      root,
      root,
      `${root}/a%2Fb`,
      `${root}/a%2Fb`,
      `${root}/a%2Fb`,
      `${root}/a%2Fb/test?detail=true`,
      `${root}/a%2Fb/test?detail=false`,
      `${root}/a%2Fb/check`,
      `${root}/a%2Fb/items?limit=20`,
    ])
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "PATCH",
      "DELETE",
      "POST",
      "POST",
      "POST",
      "GET",
    ])
    expect(request.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(input))
    expect(request.mock.calls[3]?.[1]?.body).toBe('{"enabled":true}')
    expect(request.mock.calls[1]?.[1]?.headers).toEqual({ "content-type": "application/json" })
    for (const [, init] of request.mock.calls)
      expect(new Headers(init?.headers).has("authorization")).toBe(false)
  })
  it.each([400, 409])("preserves server errors with status %s", async (status) => {
    const client = createWebListSourcesClient(async () =>
      Response.json(
        { code: "web_list_selector_invalid", message: "Invalid selector: [" },
        { status },
      ),
    )
    await expect(client.list()).rejects.toMatchObject({
      name: "WebListSourcesAPIError",
      code: "web_list_selector_invalid",
      status,
      message: "Invalid selector: [",
    })
    await expect(client.list()).rejects.toBeInstanceOf(WebListSourcesAPIError)
  })
  it("rejects error envelopes even with a successful HTTP status", async () => {
    const client = createWebListSourcesClient(async () =>
      Response.json({ code: "invalid_request", message: "Bad input" }),
    )
    await expect(client.list()).rejects.toThrow("Bad input")
  })
})
