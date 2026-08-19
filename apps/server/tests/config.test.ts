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

  it("enforces production transport, metric, and key-separation requirements", () => {
    const productionEnvironment = {
      AI_ENCRYPTION_SECRET: "independent-production-ai-secret-000000000000",
      BETTER_AUTH_SECRET: "strong-production-auth-secret-111111111111111",
      CLIENT_ORIGINS: "https://reader.example.com",
      DATABASE_URL: "postgres://folo:strong-password@postgres:5432/folo",
      METRICS_TOKEN: "strong-production-metrics-token-22222222222",
      NODE_ENV: "production",
      SERVER_URL: "https://api.reader.example.com",
      TRUST_PROXY_HOPS: "1",
    }

    expect(loadServerConfig(productionEnvironment)).toMatchObject({
      metricsToken: productionEnvironment.METRICS_TOKEN,
      nodeEnvironment: "production",
      trustProxyHops: 1,
    })
    expect(() =>
      loadServerConfig({
        ...productionEnvironment,
        AI_ENCRYPTION_SECRET: productionEnvironment.BETTER_AUTH_SECRET,
      }),
    ).toThrow()
    expect(() =>
      loadServerConfig({
        ...productionEnvironment,
        AI_ENCRYPTION_SECRET: "replace-with-a-different-random-secret-of-at-least-32-characters",
      }),
    ).toThrow()
    expect(() =>
      loadServerConfig({
        ...productionEnvironment,
        METRICS_TOKEN: undefined,
      }),
    ).toThrow()
    expect(() =>
      loadServerConfig({
        ...productionEnvironment,
        METRICS_TOKEN: productionEnvironment.BETTER_AUTH_SECRET,
      }),
    ).toThrow()
    expect(() =>
      loadServerConfig({
        ...productionEnvironment,
        METRICS_TOKEN: "replace-with-a-third-random-secret-of-at-least-32-characters",
      }),
    ).toThrow()
    expect(() =>
      loadServerConfig({
        ...productionEnvironment,
        SERVER_URL: "http://api.reader.example.com",
      }),
    ).toThrow()
  })

  it("rejects public registration combined with private-network feed access", () => {
    expect(() =>
      loadServerConfig({
        AI_ENCRYPTION_SECRET: "separate-private-feed-ai-secret-000000000000",
        ALLOW_PRIVATE_FEEDS: "true",
        ALLOW_PUBLIC_REGISTRATION: "true",
        BETTER_AUTH_SECRET: "private-feed-auth-secret-111111111111111111",
        CLIENT_ORIGINS: "https://reader.example.com",
        DATABASE_URL: "postgres://folo:folo@localhost:54329/folo",
        METRICS_TOKEN: "private-feed-metrics-secret-222222222222222",
        NODE_ENV: "production",
        SERVER_URL: "https://api.reader.example.com",
      }),
    ).toThrow()

    expect(() =>
      loadServerConfig({
        ALLOW_PRIVATE_FEEDS: "true",
        ALLOW_PUBLIC_REGISTRATION: "true",
        BETTER_AUTH_SECRET: "a-local-test-secret-that-is-at-least-32-characters",
        DATABASE_URL: "postgres://folo:folo@localhost:54329/folo",
        NODE_ENV: "test",
      }),
    ).not.toThrow()
  })
})
