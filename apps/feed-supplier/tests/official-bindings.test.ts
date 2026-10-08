import type {
  OfficialAcquisitionBinding,
  OfficialSubscriptionSummary,
  SourceAuditEvent,
} from "@follow/feed-source-contracts"
import { XMLParser } from "fast-xml-parser"
import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import type { OfficialHTTPResponse, OfficialTransport } from "../src/folo-official-client"
import { MemorySupplierRepository } from "../src/memory-repository"
import { PostgresSupplierRepository } from "../src/postgres-repository"
import type { SupplierRepository } from "../src/repository"
import { buildFeedSupplier } from "../src/server"
import { isolatedDatabaseURL } from "./support/postgres-database"

const TOKEN = "official-session-token-1234567890.signature"
const environment = {
  FOLO_OFFICIAL_API_URL: "https://api.folo.test",
  INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
  NODE_ENV: "test",
  PUBLIC_FEED_BASE_URL: "https://feeds.example.com/",
  RSSHUB_ACCESS_KEY: "rsshub-access-key-11111111111111111111",
  RSSHUB_BASE_URL: "http://rsshub:1200",
  TRUST_PROXY: "10.0.0.0/8",
}
const config = loadFeedSupplierConfig(environment)
const admin = { authorization: `Bearer ${config.adminToken}` }
const internal = { authorization: `Bearer ${config.internalToken}` }

const json = (status: number, body: unknown): OfficialHTTPResponse => ({
  body: JSON.stringify(body),
  headers: new Headers({ "content-type": "application/json" }),
  status,
})

/** A fake official API with a session and a mutable subscription list. */
const fakeOfficialAPI = () => {
  const state = {
    authorized: true,
    entriesStatus: 200,
    entryRequests: [] as Array<{ feedId: string; limit: number; withContent?: boolean }>,
    entries: [
      {
        attachments: null,
        author: `Anthropic ${"and colleagues ".repeat(120)}`,
        categories: ["research"],
        content: "<p>Full <b>body</b> & more</p>",
        description: "Summary one",
        guid: "https://www.anthropic.com/research/one",
        id: "9001",
        media: [{ type: "photo", url: "https://example.com/one.png" }],
        publishedAt: "2026-10-07T10:00:00.000Z",
        title: "Paper <one>",
        url: "https://www.anthropic.com/research/one",
      },
      {
        attachments: [
          { mime_type: "audio/mpeg", size_in_bytes: 12, url: "https://example.com/a.mp3" },
          // Bilibili players come as text/html attachments with a duration.
          { duration_in_seconds: 6748, mime_type: "text/html", url: "https://example.com/player" },
          // Huge data: URIs are skipped rather than failing the feed.
          { mime_type: "image/png", url: `data:image/png;base64,${"A".repeat(20_000)}` },
        ],
        author: null,
        categories: null,
        content: null,
        description: null,
        guid: "two",
        id: "9002",
        media: [{ height: 566, type: "image", url: "https://example.com/cover.jpg", width: 1007 }],
        publishedAt: "2026-10-06T10:00:00.000Z",
        title: null,
        url: null,
      },
    ],
    subscriptions: [
      {
        category: "AI",
        feedId: "feed-anthropic",
        feeds: { url: "rsshub://anthropic/research" },
        isPrivate: false,
        title: "Anthropic Research",
      },
      { feedId: "feed-plain", feeds: { url: "https://example.com/feed.xml" }, title: "Plain" },
      {
        category: null,
        feedId: "feed-nasa",
        feeds: { url: "rsshub://nasa/apod/" },
        isPrivate: false,
        title: null,
      },
    ] as unknown[],
  }
  const calls: string[] = []
  const transport: OfficialTransport = async (request) => {
    calls.push(`${request.method} ${request.url.pathname}`)
    const token = /better-auth\.session_token=([^;]+)$/.exec(request.headers.cookie ?? "")?.[1]
    if (!state.authorized || token !== TOKEN) {
      return request.url.pathname === "/better-auth/get-session"
        ? json(200, null)
        : json(401, { code: 1000, message: "Unauthorized" })
    }
    if (request.url.pathname === "/better-auth/get-session") {
      return json(200, {
        feedSubscriptionLimit: 150,
        role: "free",
        rsshubSubscriptionLimit: 30,
        session: { expiresAt: "2026-11-04T06:19:29.065Z" },
        user: { id: "1171163283428605952" },
      })
    }
    if (request.url.pathname === "/subscriptions")
      return json(200, { code: 0, data: state.subscriptions })
    if (request.url.pathname === "/entries" && request.method === "POST") {
      const body = JSON.parse(request.body ?? "{}") as { feedId: string; limit: number }
      state.entryRequests.push(body)
      if (state.entriesStatus !== 200) return json(state.entriesStatus, { message: "later" })
      return json(200, {
        code: 0,
        data: state.entries.slice(0, body.limit).map((entry) => ({
          entries: entry,
          feeds: {
            description: "Research from Anthropic",
            id: body.feedId,
            image: "https://example.com/logo.png",
            siteUrl: "https://www.anthropic.com/research",
            title: "Anthropic Research",
            url: "rsshub://anthropic/research",
          },
          read: false,
        })),
      })
    }
    return json(404, { code: 404 })
  }
  return { calls, state, transport }
}

// Every test gets its own database: bindings and links from one test must not leak into the next.
const baseDatabaseURL = process.env.TEST_FEED_SUPPLIER_DATABASE_URL
const repositories: Array<[string, () => Promise<SupplierRepository>]> = [
  ["memory", async () => new MemorySupplierRepository(config.auditHmacKey)],
  ...(baseDatabaseURL
    ? [
        [
          "postgres",
          async () =>
            new PostgresSupplierRepository({
              auditKey: config.auditHmacKey,
              connectionString: await isolatedDatabaseURL(baseDatabaseURL, "official_bindings"),
              maxConnections: 2,
            }),
        ] as [string, () => Promise<SupplierRepository>],
      ]
    : []),
]

const rssHubFetch = vi.fn<typeof fetch>(async () => new Response("ok"))

const feedURL = (sourceURL: string) => `/v1/feeds/rsshub?url=${encodeURIComponent(sourceURL)}`
const xml = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseTagValue: false,
})

describe.each(repositories)("official acquisition bindings (%s)", (_name, createRepository) => {
  const start = async () => {
    const official = fakeOfficialAPI()
    const server = await buildFeedSupplier({
      config,
      fetchImplementation: rssHubFetch,
      officialTransport: official.transport,
      repository: await createRepository(),
    })
    const link = await server.inject({
      headers: admin,
      method: "POST",
      payload: { token: TOKEN },
      url: "/v1/admin/official/account",
    })
    expect(link.statusCode).toBe(201)
    return { official, server }
  }
  const bind = (server: Awaited<ReturnType<typeof start>>["server"], sourceURL: string) =>
    server.inject({
      headers: admin,
      method: "POST",
      payload: { sourceURL },
      url: "/v1/admin/official/bindings",
    })
  const providerCounts = async (server: Awaited<ReturnType<typeof start>>["server"]) =>
    (await server.inject({ headers: internal, method: "GET", url: "/v1/providers" }))
      .json<{ providers: Array<Record<string, unknown>> }>()
      .providers.find((provider) => provider.id === "folo_official")

  it("lists the account's rsshub:// subscriptions as logical addresses", async () => {
    const { server } = await start()
    const response = await server.inject({
      headers: admin,
      method: "GET",
      url: "/v1/admin/official/subscriptions",
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ subscriptions: OfficialSubscriptionSummary[] }>().subscriptions).toEqual(
      [
        {
          bound: false,
          category: "AI",
          externalFeedId: "feed-anthropic",
          isPrivate: false,
          sourceURL: "rsshub://anthropic/research",
          title: "Anthropic Research",
        },
        {
          bound: false,
          category: null,
          externalFeedId: "feed-nasa",
          isPrivate: false,
          sourceURL: "rsshub://nasa/apod/",
          title: null,
        },
      ],
    )
    await server.close()
  })

  it("adopts a subscription the account already has and never writes to the account", async () => {
    const { official, server } = await start()
    const created = await bind(server, "rsshub://anthropic/research")
    expect(created.statusCode).toBe(201)
    const binding = created.json<{ binding: OfficialAcquisitionBinding }>().binding
    expect(binding).toMatchObject({
      activatedAt: expect.any(String),
      externalFeedId: "feed-anthropic",
      origin: "adopted",
      sourceURL: "rsshub://anthropic/research",
      status: "active",
    })
    expect(official.calls.filter((call) => !call.startsWith("GET "))).toEqual([])

    const again = await bind(server, "rsshub://anthropic/research")
    expect(again.statusCode).toBe(409)
    expect(await providerCounts(server)).toMatchObject({
      activeBindingCount: 1,
      failedBindingCount: 0,
    })
    const subscriptions = await server.inject({
      headers: admin,
      method: "GET",
      url: "/v1/admin/official/subscriptions",
    })
    expect(
      subscriptions
        .json<{ subscriptions: OfficialSubscriptionSummary[] }>()
        .subscriptions.map((item) => [item.sourceURL, item.bound]),
    ).toEqual([
      ["rsshub://anthropic/research", true],
      ["rsshub://nasa/apod/", false],
    ])

    const audit = await server.inject({ headers: admin, method: "GET", url: "/v1/admin/audit" })
    expect(
      audit.json<{ events: SourceAuditEvent[] }>().events.map((event) => event.action),
    ).toEqual(expect.arrayContaining(["official_binding.created", "official_binding.activated"]))
    await server.close()
  })

  it("fails a binding the account is not subscribed to, and retries once it is", async () => {
    const { official, server } = await start()
    const created = await bind(server, "rsshub://github/trending/daily/any")
    expect(created.statusCode).toBe(201)
    const binding = created.json<{ binding: OfficialAcquisitionBinding }>().binding
    expect(binding).toMatchObject({
      consecutiveFailureCount: 1,
      lastErrorCode: "official_not_subscribed",
      status: "failed",
    })
    expect(await providerCounts(server)).toMatchObject({ failedBindingCount: 1 })

    official.state.subscriptions.push({
      feedId: "feed-trending",
      feeds: { url: "rsshub://github/trending/daily/any" },
    })
    const retried = await server.inject({
      headers: admin,
      method: "POST",
      url: `/v1/admin/official/bindings/${binding.id}/retry`,
    })
    expect(retried.json<{ binding: OfficialAcquisitionBinding }>().binding).toMatchObject({
      consecutiveFailureCount: 0,
      externalFeedId: "feed-trending",
      lastErrorCode: null,
      status: "active",
    })
    await server.close()
  })

  it("rejects addresses that must not reach the official API", async () => {
    const { server } = await start()
    const cases: Array<[string, number, string]> = [
      ["https://example.com/feed.xml", 400, "invalid_source"],
      ["rsshub://example/route?token=abc", 400, "invalid_source"],
      ["not a url", 400, "invalid_source"],
    ]
    for (const [sourceURL, status, code] of cases) {
      const response = await bind(server, sourceURL)
      expect([sourceURL, response.statusCode]).toEqual([sourceURL, status])
      expect(response.json()).toMatchObject({ code })
    }

    // A route instance whose secret query parameters are bound to supplier credentials.
    const credential = await server.inject({
      headers: admin,
      method: "POST",
      payload: { name: "site-key", value: "secret-value" },
      url: "/v1/admin/credentials",
    })
    const credentialId = credential.json<{ credential: { id: string } }>().credential.id
    const route = await server.inject({
      headers: admin,
      method: "POST",
      payload: {
        name: "bound",
        secretQueryBindings: { apikey: credentialId },
        sourceURL: "rsshub://bound/route",
      },
      url: "/v1/admin/routes",
    })
    expect(route.statusCode).toBe(201)
    const bound = await bind(server, "rsshub://bound/route")
    expect(bound.statusCode).toBe(409)
    expect(bound.json()).toMatchObject({ code: "invalid_source" })
    expect(
      await server
        .inject({ headers: admin, method: "GET", url: "/v1/admin/official/bindings" })
        .then((r) => r.json<{ bindings: unknown[] }>().bindings),
    ).toEqual([])
    await server.close()
  })

  it("keeps official bindings and public links mutually exclusive", async () => {
    const { server } = await start()
    const grant = await server.inject({
      headers: admin,
      method: "POST",
      payload: { name: "phone reader" },
      url: "/v1/admin/public-feed-grants",
    })
    const grantId = grant.json<{ grant: { id: string } }>().grant.id
    const link = await server.inject({
      headers: admin,
      method: "POST",
      payload: { sourceURL: "rsshub://nasa/apod/" },
      url: `/v1/admin/public-feed-grants/${grantId}/links`,
    })
    expect(link.statusCode).toBe(201)

    const bindLinked = await bind(server, "rsshub://nasa/apod/")
    expect(bindLinked.statusCode).toBe(409)
    expect(bindLinked.json()).toMatchObject({ code: "source_has_public_link" })

    const bound = await bind(server, "rsshub://anthropic/research")
    expect(bound.statusCode).toBe(201)
    const linkBound = await server.inject({
      headers: admin,
      method: "POST",
      payload: { sourceURL: "rsshub://anthropic/research" },
      url: `/v1/admin/public-feed-grants/${grantId}/links`,
    })
    expect(linkBound.statusCode).toBe(400)
    expect(linkBound.json<{ message: string }>().message).toContain("official account")
    await server.close()
  })

  it("lists bound sources in the credential usage overview", async () => {
    const { server } = await start()
    const binding = (await bind(server, "rsshub://anthropic/research")).json<{
      binding: OfficialAcquisitionBinding
    }>().binding
    const usage = await server.inject({
      headers: admin,
      method: "GET",
      url: "/v1/admin/credential-usage",
    })
    expect(usage.statusCode).toBe(200)
    expect(usage.json<{ officialBindings: unknown[] }>().officialBindings).toEqual([
      { bindingId: binding.id, sourceURL: "rsshub://anthropic/research", status: "active" },
    ])
    await server.close()
  })

  it("unbinds without touching the official account and allows binding again", async () => {
    const { official, server } = await start()
    const binding = (await bind(server, "rsshub://anthropic/research")).json<{
      binding: OfficialAcquisitionBinding
    }>().binding
    const removed = await server.inject({
      headers: admin,
      method: "DELETE",
      url: `/v1/admin/official/bindings/${binding.id}`,
    })
    expect(removed.statusCode).toBe(204)
    expect(official.calls.filter((call) => call.startsWith("DELETE"))).toEqual([])
    const again = await server.inject({
      headers: admin,
      method: "DELETE",
      url: `/v1/admin/official/bindings/${binding.id}`,
    })
    expect(again.statusCode).toBe(404)
    expect(await providerCounts(server)).toMatchObject({ activeBindingCount: 0 })
    expect((await bind(server, "rsshub://anthropic/research")).statusCode).toBe(201)
    await server.close()
  })

  it("serves a bound source from the official account as RSS, cached with an ETag", async () => {
    const { official, server } = await start()
    const binding = (await bind(server, "rsshub://anthropic/research")).json<{
      binding: OfficialAcquisitionBinding
    }>().binding

    const first = await server.inject({
      headers: internal,
      method: "GET",
      url: feedURL("rsshub://anthropic/research"),
    })
    expect(first.statusCode).toBe(200)
    expect(first.headers["content-type"]).toContain("application/rss+xml")
    expect(first.headers["x-folo-acquisition-provider"]).toBe("folo_official")
    expect(first.headers["x-folo-upstream-url"]).toBe(
      "https://api.folo.test/entries?feedId=feed-anthropic",
    )
    expect(first.headers["x-folo-cache"]).toBe("MISS")
    expect(official.state.entryRequests).toEqual([
      { feedId: "feed-anthropic", limit: 50, withContent: true },
    ])

    const parsed = xml.parse(first.body) as {
      rss: { channel: { title: string; link: string; item: Array<Record<string, unknown>> } }
    }
    expect(parsed.rss.channel.title).toBe("Anthropic Research")
    expect(parsed.rss.channel.link).toBe("https://www.anthropic.com/research")
    const [one, two] = parsed.rss.channel.item
    expect(one).toMatchObject({
      category: "research",
      "content:encoded": "<p>Full <b>body</b> & more</p>",
      "dc:creator": expect.stringMatching(/^Anthropic and colleagues/),
      description: "Summary one",
      guid: { "#text": "https://www.anthropic.com/research/one", isPermaLink: "false" },
      link: "https://www.anthropic.com/research/one",
      title: "Paper <one>",
    })
    expect(two).toMatchObject({
      enclosure: [
        { length: "12", type: "audio/mpeg", url: "https://example.com/a.mp3" },
        { type: "text/html", url: "https://example.com/player" },
      ],
      guid: { "#text": "two", isPermaLink: "false" },
    })
    expect(two).not.toHaveProperty("link")

    const etag = first.headers.etag as string
    const notModified = await server.inject({
      headers: { ...internal, "if-none-match": etag },
      method: "GET",
      url: feedURL("rsshub://anthropic/research"),
    })
    expect(notModified.statusCode).toBe(304)
    expect(notModified.headers["x-folo-cache"]).toBe("HIT")
    expect(official.state.entryRequests).toHaveLength(1)

    const bindings = await server.inject({
      headers: admin,
      method: "GET",
      url: "/v1/admin/official/bindings",
    })
    expect(
      bindings
        .json<{ bindings: OfficialAcquisitionBinding[] }>()
        .bindings.find((item) => item.id === binding.id),
    ).toMatchObject({ consecutiveFailureCount: 0, lastSuccessAt: expect.any(String) })
    await server.close()
  })

  it("reports official failures without falling back to self-hosted RSSHub", async () => {
    const { official, server } = await start()
    const binding = (await bind(server, "rsshub://anthropic/research")).json<{
      binding: OfficialAcquisitionBinding
    }>().binding
    const rssHubCallsBefore = rssHubFetch.mock.calls.length
    official.state.entriesStatus = 503
    const failed = await server.inject({
      headers: internal,
      method: "GET",
      url: feedURL("rsshub://anthropic/research"),
    })
    expect(failed.statusCode).toBe(502)
    expect(failed.json()).toMatchObject({ code: "official_unavailable" })
    expect(rssHubFetch.mock.calls.length).toBe(rssHubCallsBefore)
    const after = await server.inject({
      headers: admin,
      method: "GET",
      url: "/v1/admin/official/bindings",
    })
    expect(
      after
        .json<{ bindings: OfficialAcquisitionBinding[] }>()
        .bindings.find((item) => item.id === binding.id),
    ).toMatchObject({
      consecutiveFailureCount: 1,
      lastErrorCode: "official_unavailable",
      status: "active",
    })

    official.state.entriesStatus = 200
    official.state.authorized = false
    const rejected = await server.inject({
      headers: internal,
      method: "GET",
      url: feedURL("rsshub://anthropic/research"),
    })
    expect(rejected.statusCode).toBe(503)
    expect(rejected.json()).toMatchObject({ code: "official_auth_invalid" })
    const callsBefore = official.calls.length
    const again = await server.inject({
      headers: internal,
      method: "GET",
      url: feedURL("rsshub://anthropic/research"),
    })
    expect(again.statusCode).toBe(503)
    expect(official.calls.length).toBe(callsBefore)

    // Unbinding returns the address to self-hosted RSSHub.
    await server.inject({
      headers: admin,
      method: "DELETE",
      url: `/v1/admin/official/bindings/${binding.id}`,
    })
    rssHubFetch.mockResolvedValueOnce(
      new Response("<rss><channel><title>self-hosted</title></channel></rss>", {
        headers: { "content-type": "application/rss+xml" },
      }),
    )
    const selfHosted = await server.inject({
      headers: internal,
      method: "GET",
      url: feedURL("rsshub://anthropic/research"),
    })
    expect(selfHosted.statusCode).toBe(200)
    expect(selfHosted.headers["x-folo-acquisition-provider"]).toBeUndefined()
    expect(selfHosted.body).toContain("self-hosted")
    await server.close()
  })

  it("marks the account auth_invalid when the official API rejects the session", async () => {
    const { official, server } = await start()
    official.state.authorized = false
    const response = await bind(server, "rsshub://anthropic/research")
    expect(response.statusCode).toBe(201)
    expect(response.json<{ binding: OfficialAcquisitionBinding }>().binding).toMatchObject({
      lastErrorCode: "official_auth_invalid",
      status: "failed",
    })
    const account = await server.inject({
      headers: admin,
      method: "GET",
      url: "/v1/admin/official/account",
    })
    expect(account.json<{ account: { status: string } }>().account.status).toBe("auth_invalid")
    const callsBefore = official.calls.length
    const next = await bind(server, "rsshub://nasa/apod/")
    expect(next.statusCode).toBe(409)
    expect(next.json()).toMatchObject({ code: "official_account_not_linked" })
    expect(official.calls.length).toBe(callsBefore)
    await server.close()
  })
})
