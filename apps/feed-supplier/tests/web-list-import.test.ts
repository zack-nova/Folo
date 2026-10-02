import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import { importWebListPreset, parseWebListPreset } from "../src/web-list-import"

const presetText = await readFile(
  new URL("../presets/feeds-agent-web-lists.json", import.meta.url),
  "utf8",
)

const source = (id: string, name: string, enabled = false) => ({
  enabled,
  feedURL: `weblist://${id}`,
  id,
  name,
})

const smallPreset = (names: string[]) =>
  JSON.stringify({
    defaults: { intervalMinutes: 360 },
    description: "test",
    sources: names.map((name, index) => ({
      description: null,
      key: `key-${index}`,
      source: {
        format: "html",
        html: { itemSelector: "li" },
        name,
        targetURL: `https://example.com/${index}/`,
      },
    })),
  })

describe("Feeds Agent web list preset", () => {
  it("validates all migrated sources with the admin API rules", () => {
    const preset = parseWebListPreset(presetText)

    expect(preset.entries).toHaveLength(17)
    expect(preset.intervalMinutes).toBe(360)
    expect(preset.entries.filter((entry) => entry.input.format === "json")).toHaveLength(4)
    expect(preset.entries.every((entry) => entry.input.enabled === false)).toBe(true)
    expect(
      preset.entries.every(
        (entry) => entry.input.timeZone === "Asia/Shanghai" || entry.key.startsWith("world-bank"),
      ),
    ).toBe(true)
  })

  it("rejects invalid and duplicate entries before contacting the supplier", () => {
    expect(() =>
      parseWebListPreset(
        JSON.stringify({
          defaults: { intervalMinutes: 360 },
          description: "test",
          sources: [
            {
              description: null,
              key: "bad",
              source: {
                format: "html",
                html: { itemSelector: "li[" },
                name: "x",
                targetURL: "https://example.com/",
              },
            },
          ],
        }),
      ),
    ).toThrow("Preset source bad is invalid")
    expect(() => parseWebListPreset(smallPreset(["Same", "same"]))).toThrow("Duplicate preset name")
  })
})

describe("web list preset import", () => {
  it("only reports the plan without --apply", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sources: [source("1", "existing")] }))

    const results = await importWebListPreset(
      parseWebListPreset(smallPreset(["Existing", "New"])),
      {
        adminToken: "admin",
        apply: false,
        baseURL: "http://supplier:3001",
        enable: false,
        fetchImplementation,
      },
    )

    expect(results.map(({ key, status }) => ({ key, status }))).toEqual([
      { key: "key-0", status: "exists" },
      { key: "key-1", status: "planned" },
    ])
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer admin",
    )
  })

  it("creates disabled sources and enables only those whose preview extracted items", async () => {
    const requests: { body: unknown; method: string; path: string }[] = []
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ body, method: init?.method ?? "GET", path: `${url.pathname}${url.search}` })
      if (url.pathname === "/v1/admin/web-list-sources" && init?.method === "GET") {
        return Response.json({ sources: [] })
      }
      if (url.pathname === "/v1/admin/web-list-sources") {
        const id = body.name === "Works" ? "a" : body.name === "Empty" ? "b" : "c"
        return Response.json({ source: source(id, body.name) }, { status: 201 })
      }
      if (url.pathname.endsWith("/a/test")) {
        return Response.json({
          detail: { detailStatus: "fetched" },
          items: [{ title: "First notice" }],
        })
      }
      if (url.pathname.endsWith("/b/test")) return Response.json({ detail: null, items: [] })
      if (url.pathname.endsWith("/c/test")) {
        return Response.json(
          { code: "web_list_http_error", message: "Page request failed with HTTP 403" },
          { status: 502 },
        )
      }
      return Response.json({ source: {} })
    })

    const results = await importWebListPreset(
      parseWebListPreset(smallPreset(["Works", "Empty", "Blocked"])),
      {
        adminToken: "admin",
        apply: true,
        baseURL: "http://supplier:3001/",
        enable: true,
        fetchImplementation,
      },
    )

    expect(results.map(({ key, status }) => ({ key, status }))).toEqual([
      { key: "key-0", status: "enabled" },
      { key: "key-1", status: "test_empty" },
      { key: "key-2", status: "test_failed" },
    ])
    expect(results[0]).toMatchObject({
      detailStatus: "fetched",
      firstTitle: "First notice",
      itemCount: 1,
    })
    expect(results[2]?.message).toBe("web_list_http_error: Page request failed with HTTP 403")
    expect(
      requests
        .filter((request) => request.method === "POST" && !request.path.includes("test"))
        .map((request) => request.body),
    ).toEqual([
      expect.objectContaining({ enabled: false, intervalMinutes: null, name: "Works" }),
      expect.objectContaining({ enabled: false, name: "Empty" }),
      expect.objectContaining({ enabled: false, name: "Blocked" }),
    ])
    expect(requests.filter((request) => request.method === "PATCH")).toEqual([
      {
        body: { enabled: true, intervalMinutes: 360 },
        method: "PATCH",
        path: "/v1/admin/web-list-sources/a",
      },
    ])
    expect(
      requests.some((request) => request.path === "/v1/admin/web-list-sources/a/test?detail=true"),
    ).toBe(true)
  })

  it("finishes existing disabled sources on a rerun with --enable", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ sources: [source("a", "Pending"), source("b", "Live", true)] }),
      )
      .mockResolvedValueOnce(Response.json({ detail: null, items: [{ title: "One" }] }))
      .mockResolvedValueOnce(Response.json({ source: {} }))

    const results = await importWebListPreset(
      parseWebListPreset(smallPreset(["Pending", "Live"])),
      {
        adminToken: "admin",
        apply: true,
        baseURL: "http://supplier:3001",
        enable: true,
        fetchImplementation,
        only: new Set(["key-0", "key-1"]),
      },
    )

    expect(results.map(({ status }) => status)).toEqual(["enabled", "exists"])
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    expect(String(fetchImplementation.mock.calls[2]?.[0])).toBe(
      "http://supplier:3001/v1/admin/web-list-sources/a",
    )
  })
})

describe("web list preset import review regressions", () => {
  it("leaves a source disabled when its detail preview failed", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sources: [] }))
      .mockResolvedValueOnce(Response.json({ source: source("a", "Works") }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({ detail: { detailStatus: "failed" }, items: [{ title: "Notice" }] }),
      )

    const results = await importWebListPreset(parseWebListPreset(smallPreset(["Works"])), {
      adminToken: "admin",
      apply: true,
      baseURL: "http://supplier:3001",
      enable: true,
      fetchImplementation,
    })

    expect(results[0]).toMatchObject({ detailStatus: "failed", status: "detail_failed" })
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    expect(fetchImplementation.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false)
  })

  it("matches existing sources by the normalized name the API stores", async () => {
    expect(() => parseWebListPreset(smallPreset(["Notice", " notice "]))).toThrow(
      "Duplicate preset name",
    )
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sources: [source("a", "Notice")] }))

    const results = await importWebListPreset(parseWebListPreset(smallPreset([" Notice "])), {
      adminToken: "admin",
      apply: true,
      baseURL: "http://supplier:3001",
      enable: false,
      fetchImplementation,
    })

    expect(results.map(({ status }) => status)).toEqual(["exists"])
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })
})
