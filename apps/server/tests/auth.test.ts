import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it } from "vitest"

import { createAuth } from "../src/auth"
import { buildServer } from "../src/server"

describe("credential authentication", () => {
  let closeServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    await closeServer?.()
    closeServer = undefined
  })

  it("registers a user and resolves the resulting session", async () => {
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "phase-one-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({ auth, clientOrigins: ["http://localhost:2233"] })
    closeServer = () => server.close()

    const registration = await server.inject({
      method: "POST",
      url: "/better-auth/sign-up/email",
      headers: { origin: "http://localhost:2233" },
      payload: {
        email: "reader@example.com",
        name: "Reader",
        password: "correct-horse-battery-staple",
      },
    })

    expect(registration.statusCode).toBe(200)
    expect(registration.json()).toMatchObject({
      user: { email: "reader@example.com", name: "Reader" },
    })

    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]
    expect(cookie).toContain("better-auth.session_token=")

    const session = await server.inject({
      method: "GET",
      url: "/better-auth/get-session",
      headers: { cookie: cookie! },
    })

    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({
      session: { userId: registration.json().user.id },
      user: { email: "reader@example.com" },
    })
  })
})

describe("capability discovery", () => {
  it("advertises only locally implemented capabilities through stage four", async () => {
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "phase-one-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({ auth, clientOrigins: ["http://localhost:2233"] })

    const health = await server.inject({ method: "GET", url: "/health" })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ status: "ok" })

    const response = await server.inject({
      method: "GET",
      url: "/api/extensions/capabilities",
    })
    await server.close()

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      code: 0,
      data: {
        compatibilityVersion: "folo-client-sdk-0.3.95",
        stage: 4,
      },
    })

    const data = response.json().data as {
      capabilities: Array<{ id: string; provider: string }>
      unavailable: string[]
    }
    expect(data.capabilities).toContainEqual({ id: "auth.credentials", provider: "local" })
    expect(data.capabilities).toContainEqual({ id: "organization.core", provider: "local" })
    expect(data.capabilities).toContainEqual({ id: "profiles.core", provider: "local" })
    expect(data.capabilities).toContainEqual({
      id: "ai.provider_configuration",
      provider: "local",
    })
    expect(data.capabilities).toContainEqual({
      id: "entries.evaluation_processing",
      provider: "local",
    })
    expect(data.capabilities).toContainEqual({ id: "entries.ai_fusion", provider: "local" })
    expect(data.capabilities).toContainEqual({
      id: "subscriptions.acquisition_diagnostics",
      provider: "local",
    })
    expect(data.capabilities).toContainEqual({ id: "operations.stability", provider: "local" })
    expect(data.capabilities).toContainEqual({ id: "subscriptions.core", provider: "local" })
    expect(data.capabilities).toContainEqual({ id: "subscriptions.opml", provider: "local" })
    expect(data.unavailable).toContain("ai.chat")
    expect(data.capabilities.some((capability) => capability.provider === "official")).toBe(false)
  })

  it("disables official-only UI and returns the frozen 501 fallback", async () => {
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "phase-one-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({ auth, clientOrigins: ["http://localhost:2233"] })

    const status = await server.inject({ method: "GET", url: "/status/configs" })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({
      code: 0,
      data: {
        AI_CHAT_ENABLED: false,
        AI_SHORTCUTS: [],
        PAYMENT_ENABLED: false,
        PAYMENT_PLAN_LIST: [],
      },
    })

    const unavailable = await server.inject({ method: "GET", url: "/wallets" })
    expect(unavailable.statusCode).toBe(501)
    expect(unavailable.json()).toEqual({
      code: "capability_not_implemented",
      message: "Capability is not implemented: billing_and_wallet",
      data: { capability: "billing_and_wallet" },
    })
    await server.close()
  })

  it("advertises autonomous suppliers independently from official hosted adapters", async () => {
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "stage-five-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({
      auth,
      clientOrigins: ["http://localhost:2233"],
      feedFetcher: {
        fetch: async () => {
          throw new Error("Not used by capability discovery")
        },
        supports: (url) =>
          url.startsWith("pagechange://") ||
          url.startsWith("rsshub://") ||
          url.startsWith("https://"),
      },
    })

    const response = await server.inject({ method: "GET", url: "/api/extensions/capabilities" })
    const data = response.json().data as {
      capabilities: Array<{ id: string; provider: string }>
      stage: number
      unavailable: string[]
    }

    expect(data.stage).toBe(5)
    expect(data.capabilities).toContainEqual({
      id: "sources.rsshub_self_hosted",
      provider: "local",
    })
    expect(data.capabilities).toContainEqual({
      id: "sources.page_change",
      provider: "local",
    })
    expect(data.unavailable).toContain("rsshub.hosted")
    await server.close()
  })
})
