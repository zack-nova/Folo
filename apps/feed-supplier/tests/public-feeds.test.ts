import type {
  IssuedPublicFeedLink,
  PublicFeedGrant,
  PublicFeedLink,
} from "@follow/feed-source-contracts"
import { describe, expect, it, vi } from "vitest"

import { createAuditDraft } from "../src/audit"
import { loadFeedSupplierConfig } from "../src/config"
import { MemorySupplierRepository } from "../src/memory-repository"
import { PostgresSupplierRepository } from "../src/postgres-repository"
import { FixedWindowLimiter, redactPublicFeedURL } from "../src/public-feed-routes"
import type { SupplierRepository } from "../src/repository"
import { buildFeedSupplier } from "../src/server"
import { isolatedDatabaseURL } from "./support/postgres-database"

const baseEnvironment = {
  INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
  NODE_ENV: "test",
  RSSHUB_ACCESS_KEY: "rsshub-access-key-11111111111111111111",
  RSSHUB_BASE_URL: "http://rsshub:1200",
}
const config = loadFeedSupplierConfig({
  ...baseEnvironment,
  PUBLIC_FEED_BASE_URL: "https://feeds.example.com/",
  TRUST_PROXY: "10.0.0.0/8",
})
const admin = { authorization: `Bearer ${config.adminToken}` }
const databaseURL = process.env.TEST_FEED_SUPPLIER_DATABASE_URL
  ? await isolatedDatabaseURL(process.env.TEST_FEED_SUPPLIER_DATABASE_URL, "public_feeds")
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

const rssFeed = (title: string) =>
  new Response(`<rss><channel><title>${title}</title></channel></rss>`, {
    headers: {
      "content-type": "application/rss+xml",
      etag: `"${title}"`,
      "last-modified": "Wed, 20 Aug 2026 00:00:00 GMT",
    },
  })

const pathOf = (link: IssuedPublicFeedLink) => new URL(link.url).pathname

describe.each(repositories)("public feed links (%s repository)", (_name, createRepository) => {
  const start = async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => rssFeed(new URL(String(input)).pathname.slice(1)))
    const server = await buildFeedSupplier({
      config,
      fetchImplementation,
      repository: createRepository(),
    })
    const createGrant = async (name: string) => {
      const response = await server.inject({
        method: "POST",
        url: "/v1/admin/public-feed-grants",
        headers: admin,
        payload: { name: `${name} ${crypto.randomUUID()}` },
      })
      expect(response.statusCode).toBe(201)
      return response.json<{ grant: PublicFeedGrant }>().grant
    }
    const issue = async (grantId: string, sourceURL: string) =>
      server.inject({
        method: "POST",
        url: `/v1/admin/public-feed-grants/${grantId}/links`,
        headers: admin,
        payload: { sourceURL },
      })
    const issueLink = async (grantId: string, sourceURL: string) => {
      const response = await issue(grantId, sourceURL)
      expect(response.statusCode).toBe(201)
      return response.json<{ link: IssuedPublicFeedLink }>().link
    }
    const read = (path: string, headers: Record<string, string> = {}) =>
      server.inject({ method: "GET", url: path, headers })
    return { createGrant, fetchImplementation, issue, issueLink, read, server }
  }

  it("serves a source through its own link, without the internal token", async () => {
    const { createGrant, issueLink, read, server } = await start()
    const grant = await createGrant("Official Folo")
    const link = await issueLink(grant.id, "rsshub://example/public")

    expect(link.url).toMatch(/^https:\/\/feeds\.example\.com\/f\/[\w-]{43}$/)
    const response = await read(pathOf(link))
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain("<title>example/public</title>")
    expect(response.headers).toMatchObject({
      "cache-control": "private, no-cache",
      "content-type": "application/rss+xml",
      etag: '"example/public"',
      "x-robots-tag": "noindex, nofollow",
    })
    // Internal diagnostics such as the upstream URL never leave through the public channel.
    expect(Object.keys(response.headers).filter((header) => header.startsWith("x-folo"))).toEqual(
      [],
    )
    expect((await read(pathOf(link), { "if-none-match": '"example/public"' })).statusCode).toBe(304)

    // The internal routes still require the internal token.
    expect((await read("/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Fpublic")).statusCode).toBe(
      401,
    )
    await server.close()
  })

  it("answers 404 for unknown, rotated and revoked links alike", async () => {
    const { createGrant, issue, issueLink, read, server } = await start()
    const grant = await createGrant("Phone reader")
    const first = await issueLink(grant.id, "rsshub://example/first")
    const second = await issueLink(grant.id, "rsshub://example/second")

    expect((await read(`/f/${"a".repeat(43)}`)).statusCode).toBe(404)
    expect((await read("/f/not-a-token")).statusCode).toBe(404)

    const rotated = await server.inject({
      method: "POST",
      url: `/v1/admin/public-feed-grants/${grant.id}/links/${first.id}/rotate`,
      headers: admin,
    })
    const rotatedLink = rotated.json<{ link: IssuedPublicFeedLink }>().link
    expect(rotatedLink.url).not.toBe(first.url)
    expect((await read(pathOf(first))).statusCode).toBe(404)
    expect((await read(pathOf(rotatedLink))).statusCode).toBe(200)

    const revoked = await server.inject({
      method: "DELETE",
      url: `/v1/admin/public-feed-grants/${grant.id}/links/${rotatedLink.id}`,
      headers: admin,
    })
    expect(revoked.statusCode).toBe(204)
    expect((await read(pathOf(rotatedLink))).statusCode).toBe(404)
    expect((await read(pathOf(second))).statusCode).toBe(200)

    // Revoking the grant disables every link it holds, and it cannot issue new ones.
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/v1/admin/public-feed-grants/${grant.id}/revoke`,
          headers: admin,
        })
      ).statusCode,
    ).toBe(204)
    expect((await read(pathOf(second))).statusCode).toBe(404)
    expect((await issue(grant.id, "rsshub://example/third")).statusCode).toBe(404)
    await server.close()
  })

  it("lists links without their URLs and exports the active ones on request", async () => {
    const { createGrant, issue, issueLink, server } = await start()
    const grant = await createGrant("Export")
    const kept = await issueLink(grant.id, "rsshub://example/kept")
    const dropped = await issueLink(grant.id, "rsshub://example/dropped")
    await server.inject({
      method: "DELETE",
      url: `/v1/admin/public-feed-grants/${grant.id}/links/${dropped.id}`,
      headers: admin,
    })

    expect((await issue(grant.id, "rsshub://example/kept")).statusCode).toBe(409)
    expect((await issue(grant.id, "https://example.com/feed.xml")).statusCode).toBe(400)
    expect(
      (await issue(grant.id, "pagechange://00000000-0000-4000-8000-000000000000")).statusCode,
    ).toBe(400)

    const listed = await server.inject({
      method: "GET",
      url: `/v1/admin/public-feed-grants/${grant.id}/links`,
      headers: admin,
    })
    const links = listed.json<{ links: PublicFeedLink[] }>().links
    expect(links.map((link) => link.sourceURL)).toEqual([
      "rsshub://example/kept",
      "rsshub://example/dropped",
    ])
    expect(JSON.stringify(links)).not.toContain(new URL(kept.url).pathname.slice(3))
    expect(links[0]).not.toHaveProperty("url")

    const exported = await server.inject({
      method: "GET",
      url: `/v1/admin/public-feed-grants/${grant.id}/export`,
      headers: admin,
    })
    expect(exported.json<{ links: IssuedPublicFeedLink[] }>().links).toEqual([
      expect.objectContaining({ sourceURL: "rsshub://example/kept", url: kept.url }),
    ])
    await server.close()
  })

  it("records the last access with the client address behind trusted proxies", async () => {
    const { createGrant, issueLink, server } = await start()
    const grant = await createGrant("Access")
    const link = await issueLink(grant.id, "rsshub://example/access")

    await server.inject({
      method: "GET",
      url: pathOf(link),
      remoteAddress: "10.0.0.2",
      headers: { "user-agent": "Folo Feed Fetcher", "x-forwarded-for": "203.0.113.9" },
    })
    await vi.waitFor(async () => {
      const grants = await server.inject({
        method: "GET",
        url: "/v1/admin/public-feed-grants",
        headers: admin,
      })
      expect(
        grants.json<{ grants: PublicFeedGrant[] }>().grants.find((item) => item.id === grant.id),
      ).toMatchObject({
        activeLinkCount: 1,
        lastAccessIP: "203.0.113.9",
        lastAccessUserAgent: "Folo Feed Fetcher",
      })
    })
    await server.close()
  })

  it("keeps grant management behind the admin token and audits it", async () => {
    const { createGrant, issueLink, server } = await start()
    for (const headers of [{}, { authorization: `Bearer ${config.internalToken}` }]) {
      expect(
        (await server.inject({ method: "GET", url: "/v1/admin/public-feed-grants", headers }))
          .statusCode,
      ).toBe(401)
    }
    const grant = await createGrant("Audited")
    await issueLink(grant.id, "rsshub://example/audited")

    const audit = await server.inject({ method: "GET", url: "/v1/admin/audit", headers: admin })
    const actions = audit
      .json<{ events: Array<{ action: string; resourceId: string | null }> }>()
      .events.map((event) => event.action)
    expect(actions).toEqual(
      expect.arrayContaining(["public_feed_grant.created", "public_feed_link.created"]),
    )
    expect(JSON.stringify(audit.json())).not.toMatch(/\/f\/[\w-]{43}/)
    await server.close()
  })
})

describe("public feed channel", () => {
  it("is not served when no public base URL is configured", async () => {
    const server = await buildFeedSupplier({ config: loadFeedSupplierConfig(baseEnvironment) })
    // Unknown routes fall under the internal token, which then reaches the router's 404.
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/v1/admin/public-feed-grants",
          headers: { authorization: `Bearer ${config.internalToken}` },
        })
      ).statusCode,
    ).toBe(404)
    expect((await server.inject({ method: "GET", url: `/f/${"a".repeat(43)}` })).statusCode).toBe(
      401,
    )
    await server.close()
  })

  it("rate limits misses per client and reads per link", async () => {
    const server = await buildFeedSupplier({
      config,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(rssFeed("limited")),
    })
    const missing = () => server.inject({ method: "GET", url: `/f/${"b".repeat(43)}` })
    for (let attempt = 0; attempt < 30; attempt++) expect((await missing()).statusCode).toBe(404)
    const limited = await missing()
    expect(limited.statusCode).toBe(429)
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0)
    await server.close()

    const limiter = new FixedWindowLimiter(2)
    expect(limiter.hit("link", 0)).toBeNull()
    expect(limiter.retryAfter("link", 500)).toBeNull()
    expect(limiter.hit("link", 1_000)).toBeNull()
    expect(limiter.retryAfter("link", 1_500)).toBe(59)
    expect(limiter.hit("link", 2_000)).toBe(58)
    expect(limiter.hit("link", 60_000)).toBeNull()

    // Many distinct clients stay bounded, oldest windows first.
    const bounded = new FixedWindowLimiter(1, 3)
    for (const [index, key] of ["a", "b", "c", "d"].entries()) bounded.hit(key, index)
    expect(bounded.size).toBe(3)
    expect(bounded.hit("a", 10)).toBeNull()
  })

  it("turns away a client over its miss budget before looking the token up", async () => {
    const repository = new MemorySupplierRepository(config.auditHmacKey)
    const lookups = vi.spyOn(repository, "findActivePublicFeedLinkByTokenHash")
    const server = await buildFeedSupplier({ config, repository })
    const missing = () => server.inject({ method: "GET", url: `/f/${"d".repeat(43)}` })
    for (let attempt = 0; attempt < 30; attempt++) expect((await missing()).statusCode).toBe(404)
    for (let attempt = 0; attempt < 5; attempt++) expect((await missing()).statusCode).toBe(429)
    expect(lookups).toHaveBeenCalledTimes(30)
    await server.close()
  })

  it("keeps link tokens out of request logs", () => {
    expect(redactPublicFeedURL(`/f/${"c".repeat(43)}`)).toBe("/f/[Redacted]")
    expect(redactPublicFeedURL(`/f/${"c".repeat(43)}?utm=1`)).toBe("/f/[Redacted]?utm=1")
    expect(redactPublicFeedURL("/v1/providers")).toBe("/v1/providers")
  })

  it("requires HTTPS for public links in production", () => {
    const production = {
      ADMIN_TOKEN: "production-admin-token-000000000000000000",
      AUDIT_HMAC_KEY: "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw=",
      CREDENTIAL_ENCRYPTION_KEY: "DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=",
      DATABASE_URL: "postgres://supplier:secret@feed-supplier-postgres:5432/supplier",
      INTERNAL_TOKEN: "production-internal-token-0000000000000000",
      NODE_ENV: "production",
      REDIS_URL: "redis://redis:6379/1",
      RSSHUB_ACCESS_KEY: "production-rsshub-access-key-000000000",
      RSSHUB_BASE_URL: "http://rsshub:1200",
      TRUST_PROXY: "loopback,uniquelocal",
    }
    expect(
      loadFeedSupplierConfig({ ...production, PUBLIC_FEED_BASE_URL: "https://feeds.example.com" })
        .publicFeedBaseURL,
    ).toBe("https://feeds.example.com")
    // Links are served at /f/<token> on the origin, so a path would only produce dead links.
    expect(() =>
      loadFeedSupplierConfig({
        ...production,
        PUBLIC_FEED_BASE_URL: "https://feeds.example.com/rss",
      }),
    ).toThrow(/origin/)
    // Without trusted proxies every client would share the proxy's miss budget.
    expect(() =>
      loadFeedSupplierConfig({
        ...production,
        PUBLIC_FEED_BASE_URL: "https://feeds.example.com",
        TRUST_PROXY: "",
      }),
    ).toThrow(/TRUST_PROXY/)
    expect(() =>
      loadFeedSupplierConfig({ ...production, PUBLIC_FEED_BASE_URL: "http://feeds.example.com" }),
    ).toThrow(/HTTPS/)
    expect(() => loadFeedSupplierConfig({ ...production, TRUST_PROXY: "10.0.0.0/33" })).toThrow(
      /TRUST_PROXY/,
    )
  })
})

describe.each([
  ["memory", () => new MemorySupplierRepository(config.auditHmacKey)],
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
        ] as [string, () => SupplierRepository],
      ]
    : []),
] as Array<[string, () => SupplierRepository]>)("public feed repository (%s)", (_name, create) => {
  it("refuses links for a grant revoked before the insert", async () => {
    const repository = create()
    await repository.initialize()
    const grantId = crypto.randomUUID()
    const audit = () =>
      createAuditDraft("test", "public_feed_grant.created", "public_feed_grant", grantId, {})
    await repository.createPublicFeedGrant(
      {
        id: grantId,
        name: `Revoked ${grantId}`,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      },
      audit(),
    )
    await repository.revokePublicFeedGrant(grantId, new Date().toISOString(), audit())
    const created = await repository.createPublicFeedLink(
      {
        id: crypto.randomUUID(),
        grantId,
        sourceURL: "rsshub://example/late",
        title: null,
        category: null,
        tokenHash: Buffer.alloc(32, 7),
        token: {
          authenticationTag: Buffer.alloc(16),
          ciphertext: Buffer.from("x"),
          initializationVector: Buffer.alloc(12),
          keyId: "test",
        },
        createdAt: new Date().toISOString(),
        rotatedAt: null,
        revokedAt: null,
        lastAccess: null,
      },
      audit(),
    )
    expect(created).toBeNull()
    expect(await repository.listPublicFeedLinks(grantId)).toEqual([])
    await repository.close()
  })

  it("does not re-encrypt a token that was rotated after it was read", async () => {
    const repository = create()
    await repository.initialize()
    const grantId = crypto.randomUUID()
    const linkId = crypto.randomUUID()
    const audit = () => createAuditDraft("test", "public_feed_link.reencrypted", "system", null, {})
    await repository.createPublicFeedGrant(
      {
        id: grantId,
        name: `Race ${grantId}`,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      },
      audit(),
    )
    const encrypted = (fill: number) => ({
      authenticationTag: Buffer.alloc(16, fill),
      ciphertext: Buffer.from(`ciphertext-${fill}`),
      initializationVector: Buffer.alloc(12, fill),
      keyId: `key-${fill}`,
    })
    await repository.createPublicFeedLink(
      {
        id: linkId,
        grantId,
        sourceURL: "rsshub://example/race",
        title: null,
        category: null,
        tokenHash: Buffer.alloc(32, 1),
        token: encrypted(1),
        createdAt: new Date().toISOString(),
        rotatedAt: null,
        revokedAt: null,
        lastAccess: null,
      },
      audit(),
    )
    // The link is rotated (new token, new hash) between the read and the re-encryption.
    await repository.rotatePublicFeedLink(
      linkId,
      { tokenHash: Buffer.alloc(32, 2), token: encrypted(2) },
      new Date().toISOString(),
      audit(),
    )
    const updated = await repository.reencryptPublicFeedLinkTokens(
      [{ id: linkId, token: encrypted(3), tokenHash: Buffer.alloc(32, 1) }],
      audit(),
    )
    expect(updated).toBe(0)
    expect((await repository.findPublicFeedLink(linkId))?.token.keyId).toBe("key-2")
    await repository.close()
  })
})
