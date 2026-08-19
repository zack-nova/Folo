import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

const fixturePath = fileURLToPath(new URL("fixtures/phase-one.rss.xml", import.meta.url))

describe("stage four operations", () => {
  let closeServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    await closeServer?.()
    closeServer = undefined
  })

  it("exposes authenticated acquisition state, bounded diagnostics, readiness, and metrics", async () => {
    const feedXML = await readFile(fixturePath, "utf8")
    let shouldFail = false
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "stage-four-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const dataStore = new MemoryDataStore()
    const projectionSpy = vi.spyOn(dataStore, "getEntryProjections")
    const server = await buildServer({
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore,
      feedFetcher: {
        fetch: async (url) => {
          if (shouldFail) throw new Error("upstream unavailable")
          return {
            body: feedXML,
            contentType: "application/rss+xml",
            etag: '"phase-four"',
            lastModified: null,
            status: 200,
            url,
          }
        },
      },
    })
    closeServer = () => server.close()
    const registration = await server.inject({
      method: "POST",
      url: "/better-auth/sign-up/email",
      headers: { origin: "http://localhost:2233" },
      payload: {
        email: "stage-four@example.com",
        name: "Stage Four",
        password: "correct-horse-battery-staple",
      },
    })
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]
    expect(cookie).toBeTruthy()
    const client = new FollowClient({
      baseURL: "http://localhost:3000",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const response = await server.inject({
          method: request.method as "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
          url: new URL(request.url).pathname + new URL(request.url).search,
          headers: { ...Object.fromEntries(request.headers.entries()), cookie: cookie! },
          payload:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : await request.text(),
        })
        return new Response(response.body, {
          headers: response.headers as unknown as HeadersInit,
          status: response.statusCode,
        })
      },
    })
    const created = await client.api.subscriptions.create({
      url: "https://feeds.example.com/stage-four.xml",
      view: 0,
    })
    const feedId = created.feed!.id

    const projectionIds = Array.from({ length: 100 }, (_, index) => `projection-${index}`)
    const projections = await server.inject({
      method: "POST",
      url: "/api/extensions/entries/projections",
      headers: { cookie: cookie! },
      payload: { entry_ids: projectionIds },
    })
    expect(projections.statusCode).toBe(200)
    expect(Object.keys(projections.json().data)).toHaveLength(100)
    expect(projectionSpy).toHaveBeenCalledTimes(1)

    const unauthorized = await server.inject({
      method: "GET",
      url: `/api/extensions/subscriptions/${feedId}/acquisition`,
    })
    expect(unauthorized.statusCode).toBe(401)

    const acquisition = await server.inject({
      method: "GET",
      url: `/api/extensions/subscriptions/${feedId}/acquisition`,
      headers: { cookie: cookie! },
    })
    expect(acquisition.json()).toMatchObject({
      code: 0,
      data: {
        active_provider: "standard_rss",
        consecutive_failures: 0,
        feed_id: feedId,
        status: "healthy",
      },
    })

    shouldFail = true
    const failedRefresh = await server.inject({
      method: "GET",
      url: `/feeds/refresh?id=${feedId}`,
      headers: { cookie: cookie! },
    })
    expect(failedRefresh.statusCode).toBe(502)

    const diagnostics = await server.inject({
      method: "GET",
      url: `/api/extensions/subscriptions/${feedId}/acquisition/diagnostics?limit=20`,
      headers: { cookie: cookie! },
    })
    expect(diagnostics.json()).toMatchObject({
      code: 0,
      data: {
        items: [{ error_code: "feed_fetch_failed", status: "failed" }, { status: "succeeded" }],
        limit: 20,
      },
    })
    expect(diagnostics.body).not.toContain("response_body")

    const ready = await server.inject({ method: "GET", url: "/ready" })
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toEqual({ status: "ready" })

    const metrics = await server.inject({ method: "GET", url: "/metrics" })
    expect(metrics.statusCode).toBe(200)
    expect(metrics.headers["content-type"]).toContain("text/plain")
    expect(metrics.body).toContain("folo_feed_acquisition_failures 1")
    expect(metrics.body).toContain('folo_processing_jobs{status="queued"} 0')

    const operations = await server.inject({
      method: "GET",
      url: "/api/extensions/operations/status",
      headers: { cookie: cookie! },
    })
    expect(operations.json()).toMatchObject({
      code: 0,
      data: {
        alerts: [{ code: "feed_acquisition_degraded", count: 1, severity: "warning" }],
        failed_processing_jobs: [],
        feed_failures: [
          {
            consecutive_failures: 1,
            feed_id: feedId,
            last_error_summary: "upstream unavailable",
          },
        ],
        stats: { feedAcquisitionFailures: 1, subscribedFeeds: 1 },
        status: "degraded",
      },
    })

    shouldFail = false
    const retry = await server.inject({
      method: "POST",
      url: `/api/extensions/operations/feeds/${feedId}/retry`,
      headers: { cookie: cookie!, origin: "http://localhost:2233" },
    })
    expect(retry.statusCode).toBe(202)
  })

  it("limits global operations status to the established instance owner", async () => {
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "stage-four-owner-test-secret-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const dataStore = new MemoryDataStore()
    const server = await buildServer({
      allowPublicRegistration: true,
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore,
    })
    closeServer = () => server.close()
    const register = async (email: string) =>
      server.inject({
        method: "POST",
        url: "/better-auth/sign-up/email",
        headers: { origin: "http://localhost:2233" },
        payload: { email, name: email, password: "correct-horse-battery-staple" },
      })

    const owner = await register("owner@example.com")
    await dataStore.claimOwner(owner.json().user.id)
    const reader = await register("reader@example.com")
    const readerCookie = reader.headers["set-cookie"]?.toString().split(";", 1)[0]

    const response = await server.inject({
      method: "GET",
      url: "/api/extensions/operations/status",
      headers: { cookie: readerCookie! },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: "forbidden" })
  })
})
