import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it } from "vitest"

import { createAuth } from "../src/auth"
import { buildServer } from "../src/server"

const createTestAuth = () =>
  createAuth({
    baseURL: "http://localhost:3000",
    database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
    secret: "production-hardening-test-secret-at-least-32-characters",
    trustedOrigins: ["http://localhost:2233"],
  })

describe("production security boundaries", () => {
  let closeServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    await closeServer?.()
    closeServer = undefined
  })

  it("adds security headers, protects metrics, and rejects cross-site mutations", async () => {
    const metricsToken = "metrics-test-token-that-is-at-least-32-characters"
    const server = await buildServer({
      auth: createTestAuth(),
      clientOrigins: ["http://localhost:2233"],
      metricsToken,
    })
    closeServer = () => server.close()

    const health = await server.inject({ method: "GET", url: "/health" })
    expect(health.headers["x-content-type-options"]).toBe("nosniff")
    expect(health.headers["x-frame-options"]).toBe("SAMEORIGIN")

    const metricsWithoutToken = await server.inject({ method: "GET", url: "/metrics" })
    expect(metricsWithoutToken.statusCode).toBe(401)
    expect(metricsWithoutToken.headers["www-authenticate"]).toContain("Bearer")

    const metrics = await server.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${metricsToken}` },
    })
    expect(metrics.statusCode).toBe(200)

    const crossSite = await server.inject({
      method: "POST",
      url: "/better-auth/sign-in/email",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      payload: { email: "reader@example.com", password: "not-the-password" },
    })
    expect(crossSite.statusCode).toBe(403)
    expect(crossSite.json()).toMatchObject({ code: "origin_not_allowed" })
  })

  it("rate limits repeated authentication attempts", async () => {
    const server = await buildServer({
      auth: createTestAuth(),
      authRateLimitMax: 1,
      clientOrigins: ["http://localhost:2233"],
    })
    closeServer = () => server.close()

    const request = () =>
      server.inject({
        method: "POST",
        url: "/better-auth/sign-in/email",
        headers: { origin: "http://localhost:2233" },
        payload: { email: "reader@example.com", password: "not-the-password" },
      })

    expect((await request()).statusCode).not.toBe(429)
    const limited = await request()
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ code: "rate_limit_exceeded" })
    expect(limited.headers["retry-after"]).toBeTruthy()
  })
})
