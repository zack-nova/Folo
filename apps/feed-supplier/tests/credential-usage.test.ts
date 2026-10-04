import { readFile } from "node:fs/promises"

import type {
  CredentialUsageReport,
  IssuedPublicFeedLink,
  PublicFeedGrant,
  PublicFeedLink,
  SourceCatalogRouteAdministration,
} from "@follow/feed-source-contracts"
import { describe, expect, it, vi } from "vitest"

import { importCatalogPreset, parseCatalogPreset } from "../src/catalog-import"
import { loadFeedSupplierConfig } from "../src/config"
import { resolveCredentialDependency } from "../src/credential-dependency"
import { MemorySupplierRepository } from "../src/memory-repository"
import { PostgresSupplierRepository } from "../src/postgres-repository"
import type { SupplierRepository } from "../src/repository"
import { buildFeedSupplier } from "../src/server"
import { isolatedDatabaseURL } from "./support/postgres-database"

const config = loadFeedSupplierConfig({
  INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
  NODE_ENV: "test",
  PUBLIC_FEED_BASE_URL: "https://feeds.example.com",
  RSSHUB_ACCESS_KEY: "rsshub-access-key-11111111111111111111",
  RSSHUB_BASE_URL: "http://rsshub:1200",
})
const admin = { authorization: `Bearer ${config.adminToken}` }
const databaseURL = process.env.TEST_FEED_SUPPLIER_DATABASE_URL
  ? await isolatedDatabaseURL(process.env.TEST_FEED_SUPPLIER_DATABASE_URL, "credential_usage")
  : undefined

const repositories: Array<[string, () => SupplierRepository | undefined]> = [
  ["memory", () => undefined],
  ...(databaseURL
    ? [
        [
          "postgres",
          () =>
            new PostgresSupplierRepository({
              auditKey: config.auditHmacKey,
              connectionString: databaseURL,
              maxConnections: 2,
            }),
        ] as [string, () => SupplierRepository | undefined],
      ]
    : []),
]

describe.each(repositories)("public link metadata and credential usage (%s)", (_name, create) => {
  const start = async () => {
    const server = await buildFeedSupplier({
      config,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response("<rss><channel /></rss>")),
      repository: create(),
    })
    const request = async <T>(
      method: "DELETE" | "GET" | "PATCH" | "POST",
      url: string,
      payload?: object,
    ) => {
      const response = await server.inject({ method, url, headers: admin, payload })
      return {
        body: (response.body ? response.json<T>() : undefined) as T,
        status: response.statusCode,
      }
    }
    // Unique per run: the PostgreSQL database is shared between runs.
    const suffix = crypto.randomUUID().slice(0, 8)
    const grant = (
      await request<{ grant: PublicFeedGrant }>("POST", "/v1/admin/public-feed-grants", {
        name: `Official Folo ${suffix}`,
      })
    ).body.grant
    return { grant, request, server, suffix }
  }

  it("keeps a title and category on each link and lets them change", async () => {
    const { grant, request, server, suffix } = await start()
    const issued = await request<{ link: IssuedPublicFeedLink }>(
      "POST",
      `/v1/admin/public-feed-grants/${grant.id}/links`,
      { sourceURL: `rsshub://example/meta-${suffix}`, title: "  Example  ", category: "财经" },
    )
    expect(issued.status).toBe(201)
    expect(issued.body.link).toMatchObject({ title: "Example", category: "财经" })

    const linkURL = `/v1/admin/public-feed-grants/${grant.id}/links/${issued.body.link.id}`
    const renamed = await request<{ link: PublicFeedLink }>("PATCH", linkURL, { title: "Renamed" })
    expect(renamed.body.link).toMatchObject({ title: "Renamed", category: "财经" })
    const cleared = await request<{ link: PublicFeedLink }>("PATCH", linkURL, { category: " " })
    expect(cleared.body.link).toMatchObject({ title: "Renamed", category: null })
    expect((await request("PATCH", linkURL, {})).status).toBe(400)
    expect((await request("PATCH", linkURL, { title: "x".repeat(300) })).status).toBe(400)

    const exported = await request<{ links: IssuedPublicFeedLink[] }>(
      "GET",
      `/v1/admin/public-feed-grants/${grant.id}/export`,
    )
    // Changing the metadata keeps the link and its URL.
    expect(exported.body.links).toEqual([
      expect.objectContaining({ title: "Renamed", category: null, url: issued.body.link.url }),
    ])

    await request("DELETE", linkURL)
    expect((await request("PATCH", linkURL, { title: "Gone" })).status).toBe(404)
    await server.close()
  })

  it("reports which links depend on personal credentials", async () => {
    const { grant, request, server, suffix } = await start()
    const template = async (
      key: string,
      routePathTemplate: string,
      rssHubCredentials?: object[] | null,
    ) =>
      (
        await request<{ route: SourceCatalogRouteAdministration }>(
          "POST",
          "/v1/admin/catalog/routes",
          {
            category: "Test",
            key: `${key}-${suffix}`,
            parameters: [],
            routePathTemplate,
            title: key,
            ...(rssHubCredentials === undefined ? {} : { rssHubCredentials }),
          },
        )
      ).body.route
    const declared = await template("declared", `/declared-${suffix}/feed`, [
      { name: "TWITTER_AUTH_TOKEN", required: true },
      { name: "BILIBILI_COOKIE_*", required: false },
    ])
    expect(declared.rssHubCredentials).toEqual([
      { name: "TWITTER_AUTH_TOKEN", required: true },
      { name: "BILIBILI_COOKIE_*", required: false },
    ])
    await template("plain", `/plain-${suffix}/feed`, [])
    const undeclared = await template("undeclared", `/undeclared-${suffix}/feed`)
    expect(undeclared.rssHubCredentials).toBeNull()
    expect(
      (
        await request("POST", "/v1/admin/catalog/routes", {
          category: "Test",
          key: `invalid-${suffix}`,
          parameters: [],
          routePathTemplate: `/invalid-${suffix}/feed`,
          rssHubCredentials: [{ name: "not an env var", required: true }],
          title: "invalid",
        })
      ).status,
    ).toBe(400)

    const credential = (
      await request<{ credential: { id: string } }>("POST", "/v1/admin/credentials", {
        name: `private-token-${suffix}`,
        value: "secret-value",
      })
    ).body.credential
    await request("POST", "/v1/admin/routes", {
      name: `bound-${suffix}`,
      secretQueryBindings: { token: credential.id },
      sourceURL: `rsshub://bound-${suffix}/feed`,
    })

    const sources = {
      bound: `rsshub://bound-${suffix}/feed`,
      declared: `rsshub://declared-${suffix}/feed`,
      plain: `rsshub://plain-${suffix}/feed`,
      unmatched: `rsshub://unmatched-${suffix}/feed`,
      undeclared: `rsshub://undeclared-${suffix}/feed`,
    }
    for (const sourceURL of Object.values(sources)) {
      const issued = await request("POST", `/v1/admin/public-feed-grants/${grant.id}/links`, {
        sourceURL,
      })
      expect(issued.status).toBe(201)
    }

    const usage = await request<CredentialUsageReport>(
      "GET",
      `/v1/admin/credential-usage?grantId=${grant.id}`,
    )
    expect(usage.status).toBe(200)
    const bySource = new Map(usage.body.links.map((link) => [link.sourceURL, link.dependency]))
    expect(bySource.get(sources.declared)).toEqual({
      status: "uses",
      boundCredentials: [],
      rssHubCredentials: [
        { name: "TWITTER_AUTH_TOKEN", required: true },
        { name: "BILIBILI_COOKIE_*", required: false },
      ],
      catalogRouteKey: `declared-${suffix}`,
    })
    expect(bySource.get(sources.bound)).toMatchObject({
      status: "uses",
      boundCredentials: [`private-token-${suffix}`],
    })
    expect(bySource.get(sources.plain)).toMatchObject({ status: "none" })
    // Without a declaration, or without a template, nothing is assumed.
    expect(bySource.get(sources.undeclared)).toMatchObject({ status: "unknown" })
    expect(bySource.get(sources.unmatched)).toMatchObject({ status: "unknown" })
    expect(usage.body.links.every((link) => link.grantName === grant.name)).toBe(true)
    expect(JSON.stringify(usage.body)).not.toContain("secret-value")

    expect(
      (await request("GET", `/v1/admin/credential-usage?grantId=${crypto.randomUUID()}`)).status,
    ).toBe(404)
    await request("POST", `/v1/admin/public-feed-grants/${grant.id}/revoke`)
    const afterRevoke = await request<CredentialUsageReport>("GET", "/v1/admin/credential-usage")
    expect(afterRevoke.body.links.filter((link) => link.grantId === grant.id)).toEqual([])
    await server.close()
  })
})

// Rotation re-encrypts everything under an older key, so it gets a database of its own.
const rotationDatabaseURL = process.env.TEST_FEED_SUPPLIER_DATABASE_URL
  ? await isolatedDatabaseURL(process.env.TEST_FEED_SUPPLIER_DATABASE_URL, "key_rotation")
  : undefined
const rotationRepositories: Array<[string, () => SupplierRepository | undefined]> = [
  ["memory", () => undefined],
  ...(rotationDatabaseURL
    ? [
        [
          "postgres",
          () =>
            new PostgresSupplierRepository({
              auditKey: config.auditHmacKey,
              connectionString: rotationDatabaseURL,
              maxConnections: 2,
            }),
        ] as [string, () => SupplierRepository | undefined],
      ]
    : []),
]

describe.each(rotationRepositories)("public link key rotation (%s)", (_name, create) => {
  it("re-encrypts link tokens so the old key can be retired", async () => {
    const oldKey = Buffer.alloc(32, 3).toString("base64")
    const newKey = Buffer.alloc(32, 4).toString("base64")
    const withKeys = (environment: Record<string, string>) =>
      loadFeedSupplierConfig({
        INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
        NODE_ENV: "test",
        PUBLIC_FEED_BASE_URL: "https://feeds.example.com",
        RSSHUB_BASE_URL: "http://rsshub:1200",
        ...environment,
      })
    // The memory repository is shared across the three servers; PostgreSQL shares the database.
    const memory = create() ? null : new MemorySupplierRepository(config.auditHmacKey)
    const repository = () => memory ?? create()
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("<rss><channel /></rss>"))
    const serverWith = (environment: Record<string, string>) =>
      buildFeedSupplier({
        config: withKeys(environment),
        fetchImplementation,
        repository: repository(),
      })
    const call = (
      server: Awaited<ReturnType<typeof serverWith>>,
      method: "GET" | "POST",
      url: string,
      payload?: object,
    ) => server.inject({ method, url, headers: admin, payload })

    const before = await serverWith({
      CREDENTIAL_ENCRYPTION_KEY: oldKey,
      CREDENTIAL_ENCRYPTION_KEY_ID: "old-key",
    })
    const grant = (
      await call(before, "POST", "/v1/admin/public-feed-grants", {
        name: `Rotation ${crypto.randomUUID()}`,
      })
    ).json<{ grant: PublicFeedGrant }>().grant
    const link = (
      await call(before, "POST", `/v1/admin/public-feed-grants/${grant.id}/links`, {
        sourceURL: "rsshub://example/rotation",
      })
    ).json<{ link: IssuedPublicFeedLink }>().link
    await before.close()

    const rotating = await serverWith({
      CREDENTIAL_DECRYPTION_KEYS_JSON: JSON.stringify({ "old-key": oldKey }),
      CREDENTIAL_ENCRYPTION_KEY: newKey,
      CREDENTIAL_ENCRYPTION_KEY_ID: "new-key",
    })
    const rotation = await call(rotating, "POST", "/v1/admin/credentials/rotate")
    expect(rotation.json()).toEqual({ publicLinkRotatedCount: 1, rotatedCount: 0 })
    // Running it again finds nothing left under the old key.
    expect((await call(rotating, "POST", "/v1/admin/credentials/rotate")).json()).toEqual({
      publicLinkRotatedCount: 0,
      rotatedCount: 0,
    })
    await rotating.close()

    const after = await serverWith({
      CREDENTIAL_ENCRYPTION_KEY: newKey,
      CREDENTIAL_ENCRYPTION_KEY_ID: "new-key",
    })
    const exported = await call(after, "GET", `/v1/admin/public-feed-grants/${grant.id}/export`)
    expect(exported.statusCode).toBe(200)
    expect(exported.json<{ links: IssuedPublicFeedLink[] }>().links[0]?.url).toBe(link.url)
    expect(
      (await after.inject({ method: "GET", url: new URL(link.url).pathname })).statusCode,
    ).toBe(200)
    await after.close()
  })
})

describe("credential dependency", () => {
  const repository = {
    findCredential: vi.fn(),
    findRouteBySourceURL: vi.fn().mockResolvedValue(null),
  }
  const catalog = { matchTemplate: vi.fn().mockResolvedValue(null) }

  it("treats web lists and page changes as credential-free and anything unparsable as unknown", async () => {
    for (const [sourceURL, status] of [
      ["weblist://00000000-0000-4000-8000-000000000000", "none"],
      ["pagechange://00000000-0000-4000-8000-000000000000", "none"],
      ["https://example.com/feed.xml", "unknown"],
      ["not a url", "unknown"],
    ] as const) {
      expect((await resolveCredentialDependency(sourceURL, repository, catalog)).status).toBe(
        status,
      )
    }
  })

  it("names a bound credential that no longer exists instead of hiding it", async () => {
    repository.findRouteBySourceURL.mockResolvedValueOnce({
      secretQueryBindings: { token: "gone" },
    })
    repository.findCredential.mockResolvedValueOnce(null)
    expect(
      await resolveCredentialDependency("rsshub://example/feed", repository, catalog),
    ).toMatchObject({ status: "uses", boundCredentials: ["missing credential gone"] })
  })
})

describe("RSSHub catalog credential declarations", () => {
  const preset = () => readFile(new URL("../presets/rsshub-catalog.json", import.meta.url), "utf8")

  it("declares the credentials of every preset route", async () => {
    const entries = await parseCatalogPreset(await preset())
    expect(entries.every((entry) => Array.isArray(entry.route.rssHubCredentials))).toBe(true)
    const byKey = new Map(entries.map((entry) => [entry.route.key, entry.route.rssHubCredentials]))
    expect(byKey.get("twitter-user")).toContainEqual({ name: "TWITTER_AUTH_TOKEN", required: true })
    expect(byKey.get("v2ex-tab")).toEqual([])
  })

  it("brings existing templates up to date and reports them without --apply", async () => {
    const stored = {
      description: "old",
      enabled: true,
      id: "1",
      key: "twitter",
      rssHubCredentials: null,
    }
    const entry = {
      route: {
        category: "Test",
        description: "new",
        key: "twitter",
        parameters: [
          { key: "id", label: "User", location: "path", required: true, type: "string" },
        ],
        routePathTemplate: "/twitter/user/:id",
        rssHubCredentials: [{ name: "TWITTER_AUTH_TOKEN", required: true }],
        title: "X",
      },
      testParameters: { id: "OpenAI" },
    }
    const entries = await parseCatalogPreset(JSON.stringify({ description: "t", routes: [entry] }))
    const options = { adminToken: "admin", baseURL: "http://supplier:3001", enable: false }

    const planned = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ routes: [stored] }))
    expect(
      await importCatalogPreset(entries, {
        ...options,
        apply: false,
        fetchImplementation: planned,
      }),
    ).toEqual([expect.objectContaining({ key: "twitter", status: "outdated" })])
    expect(planned).toHaveBeenCalledOnce()

    const applied = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ routes: [stored] }))
      .mockResolvedValueOnce(Response.json({ route: { ...stored, ...entry.route } }))
    expect(
      await importCatalogPreset(entries, { ...options, apply: true, fetchImplementation: applied }),
    ).toEqual([expect.objectContaining({ key: "twitter", status: "updated" })])
    const [url, init] = applied.mock.calls[1]!
    expect(String(url)).toBe("http://supplier:3001/v1/admin/catalog/routes/1")
    expect(init?.method).toBe("PATCH")
    expect(JSON.parse(String(init?.body))).toEqual({
      description: "new",
      rssHubCredentials: [{ name: "TWITTER_AUTH_TOKEN", required: true }],
    })
  })
})
