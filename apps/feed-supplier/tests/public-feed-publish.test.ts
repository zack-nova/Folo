import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import { publishPublicFeeds } from "../src/public-feed-publish"
import { parseSubscriptionPreset } from "../src/subscription-export"
import { parseWebListPreset } from "../src/web-list-import"

const webLists = parseWebListPreset(
  await readFile(new URL("fixtures/web-lists.example.json", import.meta.url), "utf8"),
)
const preset = (
  entries: { category: string; key: string; title: string; url?: string; webList?: string }[],
) =>
  parseSubscriptionPreset(
    JSON.stringify({ description: "test", skipped: [], subscriptions: entries }),
  )

const native = {
  category: "Reading",
  key: "native",
  title: "Native",
  url: "https://example.com/feed",
}
const rsshub = { category: "Reading", key: "rsshub", title: "RSSHub", url: "rsshub://demo/feed" }
const page = {
  category: "Updates",
  key: "page",
  title: "Page",
  url: "pagechange://123e4567-e89b-12d3-a456-426614174000",
}
const web = { category: "Updates", key: "web", title: "Notices", webList: "example-html-notices" }

const stub = (initialGrant = true) => {
  const grant = { id: "grant-1", name: "Official Folo", revokedAt: null }
  const links = new Map<
    string,
    { id: string; sourceURL: string; title: string; category: string; url: string }
  >()
  const calls: string[] = []
  let exists = initialGrant
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    calls.push(`${method} ${url.pathname}${url.search}`)
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-admin")
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as {
      category: string
      sourceURL: string
      title: string
    }
    if (url.pathname === "/v1/admin/public-feed-grants" && method === "GET")
      return Response.json({ grants: exists ? [grant] : [] })
    if (url.pathname === "/v1/admin/public-feed-grants" && method === "POST") {
      exists = true
      return Response.json({ grant }, { status: 201 })
    }
    if (url.pathname === "/v1/admin/web-list-sources")
      return Response.json({
        sources: [
          { name: "Example notices", feedURL: "weblist://123e4567-e89b-12d3-a456-426614174001" },
        ],
      })
    if (url.pathname.endsWith("/export")) return Response.json({ links: [...links.values()] })
    if (url.pathname.endsWith("/links") && method === "POST") {
      const id = `link-${links.size + 1}`
      const link = {
        id,
        sourceURL: body.sourceURL,
        title: body.title,
        category: body.category,
        url: `https://feeds.example.com/f/${id}-private-token`,
      }
      links.set(link.sourceURL, link)
      return Response.json({ link }, { status: 201 })
    }
    if (url.pathname.includes("/links/") && method === "PATCH") {
      const link = [...links.values()].find((entry) => url.pathname.endsWith(`/${entry.id}`))!
      link.title = body.title
      link.category = body.category
      return Response.json({ link })
    }
    if (url.pathname.includes("/links/") && method === "DELETE") {
      const link = [...links.values()].find((entry) => url.pathname.endsWith(`/${entry.id}`))!
      links.delete(link.sourceURL)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/v1/admin/credential-usage")
      return Response.json({
        links: [...links.values()].map((link) => ({
          grantId: grant.id,
          grantName: grant.name,
          linkId: link.id,
          sourceURL: link.sourceURL,
          title: link.title,
          category: link.category,
          dependency:
            link.title === "RSSHub"
              ? {
                  status: "uses",
                  boundCredentials: ["supplier-key"],
                  rssHubCredentials: [{ name: "RSSHUB_TOKEN", required: true }],
                  catalogRouteKey: null,
                }
              : {
                  status: "unknown",
                  boundCredentials: [],
                  rssHubCredentials: [],
                  catalogRouteKey: null,
                },
        })),
      })
    throw new Error(`Unexpected ${method} ${url.pathname}`)
  })
  return { calls, fetchImplementation, links }
}

const options = (
  fetchImplementation: typeof fetch,
  subscriptions = preset([native, rsshub, page, web]),
) => ({
  adminToken: "secret-admin",
  baseURL: "http://supplier:3001",
  fetchImplementation,
  grantName: "official folo",
  subscriptions,
  webLists,
})

describe("public feed publishing", () => {
  it("issues links, preserves native URLs and category order, then makes no second-run mutations", async () => {
    const server = stub()
    const first = await publishPublicFeeds(options(server.fetchImplementation))
    expect(server.calls.filter((call) => call.startsWith("POST"))).toHaveLength(3)
    expect(first.opml).toContain('xmlUrl="https://example.com/feed"')
    expect(first.opml).toContain('xmlUrl="https://feeds.example.com/f/link-1-private-token"')
    expect(first.opml?.indexOf('text="Reading"')).toBeLessThan(
      first.opml!.indexOf('text="Updates"'),
    )
    expect(first.opml?.match(/type="rss"/g)).toHaveLength(4)
    const before = server.calls.length
    const second = await publishPublicFeeds(options(server.fetchImplementation))
    expect(server.calls.slice(before).every((call) => call.startsWith("GET"))).toBe(true)
    expect(second.opml).toBe(first.opml)
    expect(first.lines.join("\n")).toContain("RSSHUB_TOKEN (required)")
    expect(first.lines.join("\n")).toContain("supplier-key")
    expect(first.lines.join("\n")).toContain("unknown")
    expect(first.lines.join("\n")).not.toContain("https://feeds.example.com/f/")
    expect(first.lines.join("\n")).not.toContain("secret-admin")
  })

  it("patches changed metadata and only revokes removed links when requested", async () => {
    const server = stub()
    await publishPublicFeeds(options(server.fetchImplementation, preset([rsshub, page])))
    const changed = preset([{ ...rsshub, category: "News", title: "RSSHub renamed" }])
    const retained = await publishPublicFeeds(options(server.fetchImplementation, changed))
    expect(server.calls.some((call) => call.startsWith("PATCH"))).toBe(true)
    expect(retained.lines.join("\n")).toContain("1 missing retained")
    expect(server.links).toHaveProperty("size", 2)
    const revoked = await publishPublicFeeds({
      ...options(server.fetchImplementation, changed),
      revokeMissing: true,
    })
    expect(revoked.lines.join("\n")).toContain("1 missing to revoke")
    expect(server.calls.some((call) => call.startsWith("DELETE"))).toBe(true)
    expect(server.links).toHaveProperty("size", 1)
  })

  it("prints a dry-run plan without mutations and fails for a missing grant unless creation is allowed", async () => {
    const server = stub(false)
    await expect(
      publishPublicFeeds(options(server.fetchImplementation, preset([rsshub]))),
    ).rejects.toThrow("No active grant")
    const plan = await publishPublicFeeds({
      ...options(server.fetchImplementation, preset([rsshub])),
      createGrant: true,
      dryRun: true,
    })
    expect(plan.opml).toBeNull()
    expect(plan.lines.join("\n")).toContain("Would create grant")
    expect(plan.lines.join("\n")).toContain("Would issue: Reading / RSSHub")
    expect(server.calls.every((call) => call.startsWith("GET"))).toBe(true)
    const published = await publishPublicFeeds({
      ...options(server.fetchImplementation, preset([rsshub])),
      createGrant: true,
    })
    expect(published.opml).toContain("https://feeds.example.com/f/")
  })

  it("leaves unresolved web lists out of the OPML", async () => {
    const server = stub()
    const result = await publishPublicFeeds(
      options(
        server.fetchImplementation,
        preset([
          native,
          { category: "Updates", key: "missing", title: "Missing", webList: "not-in-preset" },
        ]),
      ),
    )
    expect(result.unresolvedCount).toBe(1)
    expect(result.opml?.match(/type="rss"/g)).toHaveLength(1)
    expect(result.lines.join("\n")).toContain("Left out missing")
  })
})
