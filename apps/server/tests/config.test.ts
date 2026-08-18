import { describe, expect, it } from "vitest"

import { loadServerConfig } from "../src/config"

describe("server configuration", () => {
  it("requires an explicit database and strong authentication secret", () => {
    expect(() =>
      loadServerConfig({
        BETTER_AUTH_SECRET: "short",
        DATABASE_URL: "postgres://folo:folo@localhost:54329/folo",
      }),
    ).toThrow()

    expect(
      loadServerConfig({
        AI_API_KEY: "sk-environment-owner-key",
        AI_ENCRYPTION_SECRET: "independent-ai-secret-that-is-at-least-32-characters",
        AI_PROVIDER_BASE_URL: "https://ai.example.com/v1",
        AI_PROVIDER_MODEL: "reader-model",
        ALLOW_PRIVATE_FEEDS: "true",
        BETTER_AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
        CLIENT_ORIGINS: "http://localhost:2233,https://reader.example.com",
        DATABASE_URL: "postgres://folo:folo@localhost:54329/folo",
      }),
    ).toMatchObject({
      allowPrivateFeeds: true,
      aiEncryptionSecret: "independent-ai-secret-that-is-at-least-32-characters",
      aiProviderConfig: {
        apiKey: "sk-environment-owner-key",
        baseUrl: "https://ai.example.com/v1",
        model: "reader-model",
        timeoutMs: 60_000,
      },
      clientOrigins: ["http://localhost:2233", "https://reader.example.com"],
      port: 3000,
    })
  })
})
