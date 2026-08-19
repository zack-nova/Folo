import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import { buildFeedSupplier } from "../src/server"

const config = loadFeedSupplierConfig({
  INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
  NODE_ENV: "test",
  ROUTE_REGISTRY_MODE: "managed_only",
  RSSHUB_BASE_URL: "http://rsshub:1200",
})

const adminHeaders = {
  authorization: `Bearer ${config.adminToken}`,
  "x-folo-actor": "stage-5a4-test",
}
const internalHeaders = { authorization: `Bearer ${config.internalToken}` }

describe("self-owned source catalog", () => {
  it("publishes a parameterized route without exposing management configuration", async () => {
    const server = await buildFeedSupplier({ config, fetchImplementation: vi.fn<typeof fetch>() })

    const created = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Development",
        description: "Repository releases",
        documentationURL: "https://docs.example.com/routes/releases",
        enabled: true,
        key: "repository-releases",
        parameters: [
          {
            description: "Repository owner",
            key: "owner",
            label: "Owner",
            location: "path",
            required: true,
            type: "string",
          },
          {
            description: "Repository name",
            key: "repository",
            label: "Repository",
            location: "path",
            required: true,
            type: "string",
          },
          {
            description: null,
            key: "limit",
            label: "Limit",
            location: "query",
            maximum: 100,
            minimum: 1,
            required: false,
            type: "integer",
          },
        ],
        routePathTemplate: "/github/releases/:owner/:repository",
        secretQueryBindings: {},
        title: "Repository releases",
      },
      url: "/v1/admin/catalog/routes",
    })
    expect(created.statusCode, created.body).toBe(201)
    const routeId = created.json<{ route: { id: string } }>().route.id

    const listed = await server.inject({
      headers: internalHeaders,
      method: "GET",
      url: "/v1/catalog/routes",
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({
      routes: [
        {
          category: "Development",
          id: routeId,
          key: "repository-releases",
          requiresCredentials: false,
          routePathTemplate: "/github/releases/:owner/:repository",
        },
      ],
    })
    expect(listed.body).not.toContain("secretQueryBindings")

    const rendered = await server.inject({
      headers: internalHeaders,
      method: "POST",
      payload: { parameters: { limit: 20, owner: "DIYgod", repository: "RSSHub" } },
      url: `/v1/catalog/routes/${routeId}/render`,
    })
    expect(rendered.statusCode).toBe(200)
    expect(rendered.json()).toEqual({
      logicalURL: "rsshub://github/releases/DIYgod/RSSHub?limit=20",
    })

    await server.close()
  })

  it("tests and fetches managed catalog routes with supplier-side credentials", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response("<rss><channel><title>Private releases</title></channel></rss>", {
          headers: { "content-type": "application/rss+xml" },
        }),
    )
    const server = await buildFeedSupplier({ config, fetchImplementation })
    const credentialResponse = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: { name: "catalog-token", value: "catalog-secret-42" },
      url: "/v1/admin/credentials",
    })
    const credentialId = credentialResponse.json<{ credential: { id: string } }>().credential.id
    const created = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Development",
        key: "private-project",
        parameters: [
          {
            key: "project",
            label: "Project",
            location: "path",
            required: true,
            type: "string",
          },
          {
            defaultValue: "stable",
            key: "channel",
            label: "Channel",
            location: "query",
            options: [
              { label: "Stable", value: "stable" },
              { label: "Beta", value: "beta" },
            ],
            required: false,
            type: "enum",
          },
        ],
        routePathTemplate: "/private/releases/:project",
        secretQueryBindings: { token: credentialId },
        title: "Private project",
      },
      url: "/v1/admin/catalog/routes",
    })
    const routeId = created.json<{ route: { id: string } }>().route.id

    const tested = await server.inject({
      headers: internalHeaders,
      method: "POST",
      payload: { parameters: { project: "folo" } },
      url: `/v1/catalog/routes/${routeId}/test`,
    })
    expect(tested.statusCode, tested.body).toBe(200)
    expect(tested.json()).toMatchObject({
      logicalURL: "rsshub://private/releases/folo?channel=stable",
      upstreamStatus: 200,
      upstreamURL: "http://rsshub:1200/private/releases/folo?channel=stable",
    })
    expect(tested.body).not.toContain("catalog-secret-42")
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      new URL("http://rsshub:1200/private/releases/folo?channel=stable&token=catalog-secret-42"),
      expect.objectContaining({ redirect: "manual" }),
    )

    const feed = await server.inject({
      headers: internalHeaders,
      method: "GET",
      url: `/v1/feeds/rsshub?url=${encodeURIComponent(
        "rsshub://private/releases/folo?channel=stable",
      )}`,
    })
    expect(feed.statusCode, feed.body).toBe(200)
    expect(feed.body).not.toContain("catalog-secret-42")

    await server.close()
  })

  it("resolves typed path parameters after rendering a catalog route", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<rss><channel><title>Archive</title></channel></rss>", {
        headers: { "content-type": "application/rss+xml" },
      }),
    )
    const server = await buildFeedSupplier({ config, fetchImplementation })
    const created = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Archive",
        key: "typed-archive",
        parameters: [
          {
            key: "year",
            label: "Year",
            location: "path",
            maximum: 2100,
            minimum: 2000,
            required: true,
            type: "integer",
          },
          {
            key: "includeDrafts",
            label: "Include drafts",
            location: "path",
            required: true,
            type: "boolean",
          },
        ],
        routePathTemplate: "/archive/:year/:includeDrafts",
        title: "Typed archive",
      },
      url: "/v1/admin/catalog/routes",
    })
    const routeId = created.json<{ route: { id: string } }>().route.id
    const rendered = await server.inject({
      headers: internalHeaders,
      method: "POST",
      payload: { parameters: { includeDrafts: false, year: 2026 } },
      url: `/v1/catalog/routes/${routeId}/render`,
    })
    const logicalURL = rendered.json<{ logicalURL: string }>().logicalURL

    const feed = await server.inject({
      headers: internalHeaders,
      method: "GET",
      url: `/v1/feeds/rsshub?url=${encodeURIComponent(logicalURL)}`,
    })
    expect(feed.statusCode, feed.body).toBe(200)
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      new URL("http://rsshub:1200/archive/2026/false"),
      expect.objectContaining({ redirect: "manual" }),
    )

    await server.close()
  })

  it("rejects invalid templates, unknown values, and out-of-range parameters", async () => {
    const server = await buildFeedSupplier({ config, fetchImplementation: vi.fn<typeof fetch>() })
    const malformed = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Unsafe",
        key: "unsafe-template",
        parameters: [],
        routePathTemplate: "/route/:missing",
        title: "Unsafe template",
      },
      url: "/v1/admin/catalog/routes",
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toMatchObject({ code: "invalid_catalog_route" })

    const reservedAccessKey = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Unsafe",
        key: "reserved-access-key",
        parameters: [
          {
            key: "key",
            label: "Access key",
            location: "query",
            required: true,
            type: "string",
          },
        ],
        routePathTemplate: "/route/private",
        title: "Reserved access key",
      },
      url: "/v1/admin/catalog/routes",
    })
    expect(reservedAccessKey.statusCode).toBe(400)

    const traversal = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Unsafe",
        key: "path-traversal",
        parameters: [],
        routePathTemplate: "/route/../status",
        title: "Path traversal",
      },
      url: "/v1/admin/catalog/routes",
    })
    expect(traversal.statusCode).toBe(400)

    const dynamic = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Projects",
        key: "project-by-name",
        parameters: [
          {
            key: "project",
            label: "Project",
            location: "path",
            required: true,
            type: "string",
          },
        ],
        routePathTemplate: "/projects/:project",
        title: "Project by name",
      },
      url: "/v1/admin/catalog/routes",
    })
    expect(dynamic.statusCode).toBe(201)
    const ambiguous = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Projects",
        key: "project-releases",
        parameters: [],
        routePathTemplate: "/projects/releases",
        title: "Project releases",
      },
      url: "/v1/admin/catalog/routes",
    })
    expect(ambiguous.statusCode).toBe(409)
    expect(ambiguous.json()).toMatchObject({ code: "catalog_route_conflict" })

    const dotSegment = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Unsafe",
        key: "dot-segment",
        parameters: [
          {
            key: "value",
            label: "Value",
            location: "path",
            required: true,
            type: "string",
          },
        ],
        routePathTemplate: "/dot/:value",
        title: "Dot segment",
      },
      url: "/v1/admin/catalog/routes",
    })
    const dotSegmentRouteId = dotSegment.json<{ route: { id: string } }>().route.id
    const renderedDotSegment = await server.inject({
      headers: internalHeaders,
      method: "POST",
      payload: { parameters: { value: ".." } },
      url: `/v1/catalog/routes/${dotSegmentRouteId}/render`,
    })
    expect(renderedDotSegment.statusCode).toBe(400)

    const longRoute = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Unsafe",
        key: "oversized-source-url",
        parameters: ["first", "second", "third", "fourth"].map((key) => ({
          key,
          label: key,
          location: "path",
          required: true,
          type: "string",
        })),
        routePathTemplate: "/long/:first/:second/:third/:fourth",
        title: "Oversized source URL",
      },
      url: "/v1/admin/catalog/routes",
    })
    const longRouteId = longRoute.json<{ route: { id: string } }>().route.id
    const oversized = await server.inject({
      headers: internalHeaders,
      method: "POST",
      payload: {
        parameters: {
          first: "a".repeat(512),
          fourth: "d".repeat(512),
          second: "b".repeat(512),
          third: "c".repeat(512),
        },
      },
      url: `/v1/catalog/routes/${longRouteId}/render`,
    })
    expect(oversized.statusCode).toBe(400)

    const created = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Numbers",
        key: "bounded-route",
        parameters: [
          {
            key: "limit",
            label: "Limit",
            location: "query",
            maximum: 10,
            minimum: 1,
            required: true,
            type: "integer",
          },
        ],
        routePathTemplate: "/bounded/feed",
        title: "Bounded feed",
      },
      url: "/v1/admin/catalog/routes",
    })
    const routeId = created.json<{ route: { id: string } }>().route.id
    for (const parameters of [{ limit: 11 }, { limit: 2, token: "not-allowed" }]) {
      const response = await server.inject({
        headers: internalHeaders,
        method: "POST",
        payload: { parameters },
        url: `/v1/catalog/routes/${routeId}/render`,
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ code: "invalid_catalog_route" })
    }

    await server.close()
  })

  it("updates, hides, and deletes catalog routes with append-only audit events", async () => {
    const server = await buildFeedSupplier({ config, fetchImplementation: vi.fn<typeof fetch>() })
    const created = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        category: "Status",
        key: "service-status",
        parameters: [],
        routePathTemplate: "/service/status",
        title: "Service status",
      },
      url: "/v1/admin/catalog/routes",
    })
    const routeId = created.json<{ route: { id: string } }>().route.id
    const disabled = await server.inject({
      headers: adminHeaders,
      method: "PATCH",
      payload: { enabled: false, title: "Private service status" },
      url: `/v1/admin/catalog/routes/${routeId}`,
    })
    expect(disabled.json()).toMatchObject({
      route: { enabled: false, title: "Private service status" },
    })
    const publicRoutes = await server.inject({
      headers: internalHeaders,
      method: "GET",
      url: "/v1/catalog/routes",
    })
    expect(publicRoutes.json()).toEqual({ routes: [] })
    expect(
      (
        await server.inject({
          headers: adminHeaders,
          method: "DELETE",
          url: `/v1/admin/catalog/routes/${routeId}`,
        })
      ).statusCode,
    ).toBe(204)
    const audit = await server.inject({
      headers: adminHeaders,
      method: "GET",
      url: "/v1/admin/audit",
    })
    expect(
      audit.json<{ events: Array<{ action: string }> }>().events.map((event) => event.action),
    ).toEqual(["catalog_route.created", "catalog_route.updated", "catalog_route.deleted"])

    await server.close()
  })
})
