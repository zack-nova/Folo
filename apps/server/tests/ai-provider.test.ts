import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

describe("self-hosted AI provider configuration", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("stores an OpenAI-compatible BYOK configuration without exposing the API key", async () => {
    const providerFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "A summary generated with the stored owner key." } }],
          model: "reader-model",
          usage: { completion_tokens: 8, prompt_tokens: 12 },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    )
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "provider-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({
      aiEncryptionSecret: "provider-encryption-secret-that-is-at-least-32-characters",
      aiProviderFetch: providerFetch,
      aiProviderConfig: {
        apiKey: "sk-environment-secret-value",
        baseUrl: "https://environment-ai.example.com/v1",
        model: "environment-model",
      },
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new MemoryDataStore(),
      feedFetcher: {
        fetch: async (url) => ({
          body: `<?xml version="1.0"?><rss version="2.0"><channel><title>BYOK</title><link>https://example.com</link><item><guid>byok</guid><title>Encrypted key</title><description>The key stays on the server.</description></item></channel></rss>`,
          contentType: "application/rss+xml",
          etag: null,
          lastModified: null,
          url,
        }),
      },
    })
    servers.push(server)

    const registration = await server.inject({
      method: "POST",
      url: "/better-auth/sign-up/email",
      headers: { origin: "http://localhost:2233" },
      payload: {
        email: "owner@example.com",
        name: "Owner",
        password: "correct-horse-battery-staple",
      },
    })
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]
    expect(cookie).toBeTruthy()

    const saved = await server.inject({
      method: "PUT",
      url: "/api/extensions/ai/provider",
      headers: { cookie: cookie! },
      payload: {
        api_key: "sk-self-hosted-secret-value",
        base_url: "https://ai.example.com/v1/",
        model: "reader-model",
      },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({
      code: 0,
      data: {
        base_url: "https://ai.example.com/v1",
        configured: true,
        key_hint: "…alue",
        key_source: "stored",
        model: "reader-model",
        type: "openai-compatible",
      },
    })
    expect(saved.body).not.toContain("sk-self-hosted-secret-value")

    const loaded = await server.inject({
      method: "GET",
      url: "/api/extensions/ai/provider",
      headers: { cookie: cookie! },
    })
    expect(loaded.statusCode).toBe(200)
    expect(loaded.json()).toEqual(saved.json())
    expect(loaded.body).not.toContain("sk-self-hosted-secret-value")

    const subscribed = await server.inject({
      method: "POST",
      url: "/subscriptions",
      headers: { cookie: cookie! },
      payload: { url: "https://feeds.example.com/byok.xml", view: 0 },
    })
    expect(subscribed.statusCode).toBe(200)
    const entries = await server.inject({
      method: "POST",
      url: "/entries",
      headers: { cookie: cookie! },
      payload: { view: 0 },
    })
    const entryId = entries.json().data[0].entries.id as string
    const summary = await server.inject({
      method: "GET",
      url: `/ai/summary?id=${entryId}&language=en&target=content`,
      headers: { cookie: cookie! },
    })
    expect(summary.json()).toEqual({
      code: 0,
      data: "A summary generated with the stored owner key.",
    })
    expect(providerFetch).toHaveBeenCalledTimes(1)
    const [providerURL, providerRequest] = providerFetch.mock.calls[0]!
    expect(providerURL).toBe("https://ai.example.com/v1/chat/completions")
    expect(providerRequest?.headers).toMatchObject({
      authorization: "Bearer sk-self-hosted-secret-value",
    })

    const removed = await server.inject({
      method: "DELETE",
      url: "/api/extensions/ai/provider",
      headers: { cookie: cookie! },
    })
    expect(removed.statusCode).toBe(200)
    const environmentFallback = await server.inject({
      method: "GET",
      url: "/api/extensions/ai/provider",
      headers: { cookie: cookie! },
    })
    expect(environmentFallback.json()).toEqual({
      code: 0,
      data: {
        base_url: "https://environment-ai.example.com/v1",
        configured: true,
        key_hint: null,
        key_source: "environment",
        model: "environment-model",
        type: "openai-compatible",
      },
    })
    expect(environmentFallback.body).not.toContain("sk-environment-secret-value")
    expect(environmentFallback.body).not.toContain("alue")
  })
})
