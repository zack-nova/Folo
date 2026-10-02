import type { WebListSource } from "@follow/feed-source-contracts"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { WebListManagementClient } from "../src/feeds/web-list-management"
import { buildServer } from "../src/server"

const sourceId = "5f0c1d7e-2a8b-4c3d-9e1f-0a2b3c4d5e6f"
const source: WebListSource = {
  consecutiveFailures: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
  detail: { contentSelectors: [".TRS_Editor"], enabled: true, ignoreSelectors: [] },
  enabled: false,
  feedURL: `weblist://${sourceId}`,
  filters: {
    excludeTextPatterns: [],
    excludeURLPatterns: [],
    includeTextPatterns: [],
    includeURLPatterns: ["/notices/"],
  },
  format: "html",
  html: {
    dateSelector: null,
    itemSelector: ".list li",
    linkSelector: null,
    summarySelector: null,
    titleSelector: null,
  },
  id: sourceId,
  intervalMinutes: null,
  itemCount: 0,
  json: null,
  lastAttemptAt: null,
  lastErrorCode: null,
  lastErrorSummary: null,
  lastSuccessAt: null,
  maxItems: 20,
  maxPages: 1,
  name: "发改委通知",
  nextCheckAt: null,
  targetURL: "https://www.example.gov.cn/notices/",
  timeZone: "Asia/Shanghai",
  updatedAt: "2026-10-01T00:00:00.000Z",
}

const managementToken = "management-supplier-token-00000000000000"

describe("web list owner management", () => {
  const servers: Array<{ close: () => Promise<void> }> = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  const setup = async (supplierFetch: typeof fetch, managed = true) => {
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "stage-five-web-list-test-secret-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const dataStore = new MemoryDataStore()
    const server = await buildServer({
      allowPublicRegistration: true,
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore,
      feedFetcher: {
        fetch: async () => {
          throw new Error("not used")
        },
        supports: (url) => url.startsWith("weblist://") || url.startsWith("https://"),
      },
      webListManagementClient: managed
        ? new WebListManagementClient({
            baseURL: "http://feed-supplier:3001",
            fetchImplementation: supplierFetch,
            token: managementToken,
          })
        : undefined,
    })
    servers.push(server)
    // Public registration does not claim an owner, so the first account claims it explicitly.
    const signUp = async (email: string, { owner = false } = {}) => {
      const registration = await server.inject({
        headers: { origin: "http://localhost:2233" },
        method: "POST",
        payload: { email, name: email, password: "correct-horse-battery-staple" },
        url: "/better-auth/sign-up/email",
      })
      if (owner) await dataStore.claimOwner(registration.json<{ user: { id: string } }>().user.id)
      return {
        cookie: registration.headers["set-cookie"]?.toString().split(";", 1)[0]!,
        origin: "http://localhost:2233",
      }
    }
    return { server, signUp }
  }

  it("advertises management only when the management client is configured", async () => {
    const managed = await setup(vi.fn<typeof fetch>())
    const unmanaged = await setup(vi.fn<typeof fetch>(), false)
    const capabilityIds = async (server: typeof managed.server) =>
      (
        (await server.inject({ url: "/api/extensions/capabilities" })).json().data
          .capabilities as Array<{ id: string }>
      ).map(({ id }) => id)

    expect(await capabilityIds(managed.server)).toEqual(
      expect.arrayContaining(["sources.web_list", "sources.web_list_management"]),
    )
    expect(await capabilityIds(unmanaged.server)).toContain("sources.web_list")
    expect(await capabilityIds(unmanaged.server)).not.toContain("sources.web_list_management")
  })

  it("proxies owner requests with the management token and the owner as actor", async () => {
    const supplierFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (init?.method === "POST" && url.pathname === "/v1/manage/web-list-sources") {
        return Response.json({ source }, { status: 201 })
      }
      if (init?.method === "PATCH") {
        return Response.json(
          { code: "web_list_selector_invalid", message: "Invalid CSS selector" },
          { status: 400 },
        )
      }
      if (url.pathname.endsWith("/check")) {
        return Response.json({ publishedCount: 3, source, status: "items_published" })
      }
      return Response.json({ sources: [source] })
    })
    const { server, signUp } = await setup(supplierFetch)
    const owner = await signUp("owner@example.com", { owner: true })

    const created = await server.inject({
      headers: owner,
      method: "POST",
      payload: { format: "html", html: {}, name: source.name, targetURL: source.targetURL },
      url: "/api/extensions/sources/web-lists",
    })
    expect(created.json()).toEqual({ code: 0, data: { source } })
    const [requestURL, init] = supplierFetch.mock.calls[0]!
    expect(String(requestURL)).toBe("http://feed-supplier:3001/v1/manage/web-list-sources")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${managementToken}`)
    expect(headers.get("x-folo-actor")).toMatch(/^folo-owner \S+$/)
    expect(JSON.parse(String(init?.body))).toMatchObject({ name: source.name })

    const rejected = await server.inject({
      headers: owner,
      method: "PATCH",
      payload: { html: { itemSelector: "[" } },
      url: `/api/extensions/sources/web-lists/${sourceId}`,
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toEqual({
      code: "web_list_selector_invalid",
      message: "Invalid CSS selector",
    })

    const checked = await server.inject({
      headers: owner,
      method: "POST",
      url: `/api/extensions/sources/web-lists/${sourceId}/check`,
    })
    expect(checked.json()).toMatchObject({ code: 0, data: { publishedCount: 3 } })
    expect(JSON.stringify(created.json())).not.toContain(managementToken)
  })

  it("refuses visitors, other accounts and malformed source IDs", async () => {
    const supplierFetch = vi.fn<typeof fetch>(async () => Response.json({ sources: [] }))
    const { server, signUp } = await setup(supplierFetch)
    const owner = await signUp("owner@example.com", { owner: true })
    const member = await signUp("member@example.com")

    expect((await server.inject({ url: "/api/extensions/sources/web-lists" })).statusCode).toBe(401)
    expect(
      (await server.inject({ headers: member, url: "/api/extensions/sources/web-lists" }))
        .statusCode,
    ).toBe(403)
    const malformed = await server.inject({
      headers: owner,
      url: "/api/extensions/sources/web-lists/..%2Fadmin%2Fcredentials",
    })
    expect(malformed.statusCode).toBe(404)
    expect(supplierFetch).not.toHaveBeenCalled()
  })

  it("never relays fields outside the web list contract", async () => {
    const { server, signUp } = await setup(
      vi.fn<typeof fetch>(async () =>
        Response.json({ sources: [{ ...source, secretQueryBindings: { token: "credential" } }] }),
      ),
    )
    const owner = await signUp("owner@example.com", { owner: true })

    const listed = await server.inject({ headers: owner, url: "/api/extensions/sources/web-lists" })

    expect(listed.statusCode).toBe(502)
    expect(listed.body).not.toContain("credential")
  })

  it("hides supplier failure details and accepts long Unicode titles", async () => {
    const title = "🛰".repeat(151)
    const supplierFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/check")) {
        return Response.json(
          { code: "internal_error", message: "connect ECONNREFUSED 10.0.0.5:5432 (supplier db)" },
          { status: 500 },
        )
      }
      if (url.pathname.endsWith("/test")) {
        return Response.json(
          { code: "unavailable", message: "redis at 10.0.0.6 down" },
          { status: 503 },
        )
      }
      return Response.json({
        items: [
          {
            content: null,
            detailStatus: "skipped",
            discoveredAt: "2026-10-01T00:00:00.000Z",
            guid: `urn:folo:web-list:${sourceId}:${"a".repeat(32)}`,
            id: "8bd44f7a-84d2-4b0c-b052-3cdacbfc3919",
            publishedAt: null,
            sourceId,
            summary: null,
            title,
            url: "https://www.example.gov.cn/notices/1.html",
          },
        ],
      })
    })
    const { server, signUp } = await setup(supplierFetch)
    const owner = await signUp("owner@example.com", { owner: true })

    for (const action of ["check", "test"]) {
      const failed = await server.inject({
        headers: owner,
        method: "POST",
        url: `/api/extensions/sources/web-lists/${sourceId}/${action}`,
      })
      expect(failed.statusCode).toBe(502)
      expect(failed.body).not.toMatch(/10\.0\.0|ECONNREFUSED|redis/)
    }
    const items = await server.inject({
      headers: owner,
      url: `/api/extensions/sources/web-lists/${sourceId}/items`,
    })
    expect(items.statusCode, items.body).toBe(200)
    expect(items.json().data.items[0].title).toBe(title)
  })
})
