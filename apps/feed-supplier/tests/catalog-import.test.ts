import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import { importCatalogPreset, parseCatalogPreset } from "../src/catalog-import"
import {
  parseSubscriptionPreset,
  renderSubscriptionOpml,
  resolveSubscriptions,
} from "../src/subscription-export"
import { parseWebListPreset } from "../src/web-list-import"

const preset = (name: string) => readFile(new URL(`../presets/${name}`, import.meta.url), "utf8")

const route = (key: string, template = `/example/${key}`) => ({
  route: {
    category: "Test",
    key,
    parameters: [] as Record<string, unknown>[],
    routePathTemplate: template,
    title: key,
  },
  testParameters: {},
})
const catalogPreset = (...routes: ReturnType<typeof route>[]) =>
  JSON.stringify({ description: "test", routes })
const stored = (key: string, id: string, enabled: boolean) => ({ enabled, id, key })

describe("RSSHub catalog preset", () => {
  it("validates every template and sample parameter with the catalog rules", async () => {
    const entries = await parseCatalogPreset(await preset("rsshub-catalog.json"))

    expect(entries).toHaveLength(19)
    expect(entries.every((entry) => entry.route.enabled === false)).toBe(true)
    expect(entries.find((entry) => entry.route.key === "twitter-user")).toMatchObject({
      route: { routePathTemplate: "/twitter/user/:id" },
      testParameters: { id: "OpenAI" },
    })
  })

  it("rejects overlapping templates and invalid sample parameters", async () => {
    await expect(
      parseCatalogPreset(catalogPreset(route("a", "/same/path"), route("b", "/same/path"))),
    ).rejects.toThrow("Preset route b is invalid")
    await expect(
      parseCatalogPreset(
        catalogPreset({
          ...route("c", "/v2ex/topics/:type"),
          route: {
            ...route("c").route,
            parameters: [
              {
                key: "type",
                label: "Type",
                location: "path",
                options: [{ label: "Hot", value: "hot" }],
                required: true,
                type: "enum",
              },
            ],
            routePathTemplate: "/v2ex/topics/:type",
          },
          testParameters: { type: "cold" },
        }),
      ),
    ).rejects.toThrow("Preset route c is invalid")
  })
})

describe("RSSHub catalog import", () => {
  it("plans without --apply and skips routes that already exist", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ routes: [stored("a", "1", true)] }))

    const results = await importCatalogPreset(
      await parseCatalogPreset(catalogPreset(route("a"), route("b"))),
      {
        adminToken: "admin",
        apply: false,
        baseURL: "http://supplier:3001",
        enable: false,
        fetchImplementation,
      },
    )

    expect(results.map(({ key, status }) => ({ key, status }))).toEqual([
      { key: "a", status: "exists" },
      { key: "b", status: "planned" },
    ])
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it("tests disabled routes and enables only those that pass", async () => {
    const calls: { body: unknown; method: string; path: string }[] = []
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ body, method: init?.method ?? "GET", path: url.pathname })
      if (init?.method === "GET") return Response.json({ routes: [stored("existing", "e", false)] })
      if (init?.method === "POST" && url.pathname === "/v1/admin/catalog/routes") {
        return Response.json({ route: stored(body.key, `id-${body.key}`, false) }, { status: 201 })
      }
      if (url.pathname.endsWith("/id-works/test")) {
        return Response.json({ contentBytes: 512, logicalURL: "rsshub://example/works" })
      }
      if (url.pathname.endsWith("/test")) {
        return Response.json(
          { code: "rsshub_request_failed", message: "RSSHub request failed with HTTP 503" },
          { status: 502 },
        )
      }
      return Response.json({ route: {} })
    })

    const results = await importCatalogPreset(
      await parseCatalogPreset(catalogPreset(route("works"), route("broken"), route("existing"))),
      {
        adminToken: "admin",
        apply: true,
        baseURL: "http://supplier:3001",
        enable: true,
        fetchImplementation,
      },
    )

    expect(results).toEqual([
      expect.objectContaining({
        contentBytes: 512,
        key: "works",
        logicalURL: "rsshub://example/works",
        status: "enabled",
      }),
      expect.objectContaining({
        key: "broken",
        message: "rsshub_request_failed: RSSHub request failed with HTTP 503",
        status: "test_failed",
      }),
      expect.objectContaining({ key: "existing", status: "test_failed" }),
    ])
    expect(
      calls
        .filter((call) => call.method === "POST" && !call.path.endsWith("/test"))
        .map((call) => call.body),
    ).toEqual([
      expect.objectContaining({ enabled: false, key: "works" }),
      expect.objectContaining({ enabled: false, key: "broken" }),
    ])
    expect(
      calls.filter((call) => call.method === "PATCH").map((call) => [call.path, call.body]),
    ).toEqual([["/v1/admin/catalog/routes/id-works", { enabled: true }]])
    // Every route is tested while still disabled; failures never touch the enabled flag.
    expect(calls.filter((call) => call.path.endsWith("/test"))).toHaveLength(3)
  })
})

describe("Feeds Agent subscription export", () => {
  it("maps every enabled subscription to a subscribable address", async () => {
    const subscriptions = parseSubscriptionPreset(await preset("feeds-agent-subscriptions.json"))
    const webLists = parseWebListPreset(await preset("feeds-agent-web-lists.json"))
    const listKeys = new Set(webLists.entries.map((entry) => entry.key))

    expect(subscriptions.subscriptions).toHaveLength(68)
    expect(
      subscriptions.subscriptions.filter(
        (subscription) =>
          "url" in subscription && subscription.url.startsWith("rsshub://twitter/user/"),
      ),
    ).toHaveLength(26)
    for (const subscription of subscriptions.subscriptions) {
      if ("webList" in subscription) expect(listKeys.has(subscription.webList)).toBe(true)
    }
    expect(subscriptions.skipped.map((entry) => entry.key)).toEqual([
      "icj-rss",
      "wechat-ai-minjiezhe",
    ])
  })

  it("resolves web lists by name on the supplier and reports the rest", async () => {
    const subscriptions = parseSubscriptionPreset(
      JSON.stringify({
        description: "test",
        skipped: [],
        subscriptions: [
          {
            category: "AI",
            key: "blog",
            title: "Blog & Notes",
            url: "https://example.com/feed.xml",
          },
          { category: "政治社会", key: "ndrc", title: "发改委", webList: "ndrc-policy-notices" },
          { category: "政治社会", key: "moe", title: "教育部", webList: "moe-latest-documents" },
        ],
      }),
    )
    const webLists = parseWebListPreset(await preset("feeds-agent-web-lists.json"))
    const ndrc = webLists.entries.find((entry) => entry.key === "ndrc-policy-notices")!
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        sources: [
          { feedURL: "weblist://5f0c1d7e-2a8b-4c3d-9e1f-0a2b3c4d5e6f", name: ndrc.input.name },
        ],
      }),
    )

    const { resolved, unresolved } = await resolveSubscriptions(subscriptions, webLists, {
      adminToken: "admin",
      baseURL: "http://supplier:3001",
      fetchImplementation,
    })

    expect(resolved.map((item) => item.url)).toEqual([
      "https://example.com/feed.xml",
      "weblist://5f0c1d7e-2a8b-4c3d-9e1f-0a2b3c4d5e6f",
    ])
    expect(unresolved).toEqual([
      expect.objectContaining({ key: "moe", reason: expect.stringContaining("does not exist") }),
    ])
    const opml = renderSubscriptionOpml(resolved, "Feeds Agent")
    expect(opml).toContain('<outline text="AI" title="AI">')
    expect(opml).toContain('text="Blog &amp; Notes"')
    expect(opml.indexOf('text="AI"')).toBeLessThan(opml.indexOf('text="政治社会"'))
  })

  it("leaves web lists out when no supplier token is given", async () => {
    const { resolved, unresolved } = await resolveSubscriptions(
      parseSubscriptionPreset(await preset("feeds-agent-subscriptions.json")),
      parseWebListPreset(await preset("feeds-agent-web-lists.json")),
      null,
    )
    expect(resolved).toHaveLength(50)
    expect(unresolved).toHaveLength(18)
  })
})
