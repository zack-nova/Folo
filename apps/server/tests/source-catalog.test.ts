import type { SourceCatalogRoute, SourceCatalogTestResult } from "@follow/feed-source-contracts"
import { memoryAdapter } from "better-auth/adapters/memory"
import { describe, expect, it, vi } from "vitest"

import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

describe("source catalog owner proxy", () => {
  it("keeps supplier credentials behind owner-authenticated catalog APIs", async () => {
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "stage-five-catalog-test-secret-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const route: SourceCatalogRoute = {
      category: "Development",
      createdAt: "2026-08-19T00:00:00.000Z",
      description: "Repository releases",
      documentationURL: null,
      enabled: true,
      id: "8bd44f7a-84d2-4b0c-b052-3cdacbfc3919",
      key: "repository-releases",
      parameters: [],
      requiresCredentials: true,
      routePathTemplate: "/github/releases/:owner/:repository",
      title: "Repository releases",
      updatedAt: "2026-08-19T00:00:00.000Z",
    }
    const testResult: SourceCatalogTestResult = {
      contentBytes: 128,
      contentType: "application/rss+xml",
      logicalURL: "rsshub://github/releases/DIYgod/RSSHub",
      upstreamStatus: 200,
      upstreamURL: "http://rsshub:1200/github/releases/DIYgod/RSSHub",
    }
    const catalogClient = {
      listRoutes: vi.fn(async () => [route]),
      renderRoute: vi.fn(async () => ({ logicalURL: testResult.logicalURL })),
      testRoute: vi.fn(async () => testResult),
    }
    const server = await buildServer({
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new MemoryDataStore(),
      sourceCatalogClient: catalogClient,
    })

    const capabilities = await server.inject({
      method: "GET",
      url: "/api/extensions/capabilities",
    })
    expect(capabilities.json().data).toMatchObject({
      capabilities: expect.arrayContaining([{ id: "sources.route_catalog", provider: "local" }]),
      stage: 5,
    })

    const unauthorized = await server.inject({
      method: "GET",
      url: "/api/extensions/sources/catalog",
    })
    expect(unauthorized.statusCode).toBe(401)

    const registration = await server.inject({
      headers: { origin: "http://localhost:2233" },
      method: "POST",
      payload: {
        email: "catalog-owner@example.com",
        name: "Catalog owner",
        password: "correct-horse-battery-staple",
      },
      url: "/better-auth/sign-up/email",
    })
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]
    const listed = await server.inject({
      headers: { cookie: cookie! },
      method: "GET",
      url: "/api/extensions/sources/catalog",
    })
    expect(listed.json()).toEqual({ code: 0, data: { routes: [route] } })

    const payload = { parameters: { owner: "DIYgod", repository: "RSSHub" } }
    const rendered = await server.inject({
      headers: { cookie: cookie!, origin: "http://localhost:2233" },
      method: "POST",
      payload,
      url: `/api/extensions/sources/catalog/${route.id}/render`,
    })
    expect(rendered.json()).toEqual({
      code: 0,
      data: { logicalURL: testResult.logicalURL },
    })
    expect(catalogClient.renderRoute).toHaveBeenCalledWith(route.id, payload.parameters)

    const tested = await server.inject({
      headers: { cookie: cookie!, origin: "http://localhost:2233" },
      method: "POST",
      payload,
      url: `/api/extensions/sources/catalog/${route.id}/test`,
    })
    expect(tested.json()).toEqual({ code: 0, data: testResult })
    expect(tested.body).not.toContain("supplier-token")

    await server.close()
  })
})
