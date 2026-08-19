import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import { CredentialCipher } from "../src/credential-cipher"
import { buildFeedSupplier } from "../src/server"

const config = loadFeedSupplierConfig({
  INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
  NODE_ENV: "test",
  RSSHUB_ACCESS_KEY: "rsshub-access-key-11111111111111111111",
  RSSHUB_BASE_URL: "http://rsshub:1200",
})

const adminHeaders = {
  authorization: `Bearer ${config.adminToken}`,
  "x-folo-actor": "stage-5a-test",
}

describe("source registry management", () => {
  it("persists encrypted credentials, resolves managed routes, and verifies audit history", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response("<rss><channel><title>Private</title></channel></rss>", {
          headers: { "content-type": "application/rss+xml" },
        }),
    )
    const server = await buildFeedSupplier({ config, fetchImplementation })

    const denied = await server.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET",
      url: "/v1/admin/credentials",
    })
    expect(denied.statusCode).toBe(401)

    const credentialResponse = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: { description: "Private route token", name: "private-token", value: "secret-42" },
      url: "/v1/admin/credentials",
    })
    expect(credentialResponse.statusCode).toBe(201)
    expect(credentialResponse.body).not.toContain("secret-42")
    const credential = credentialResponse.json<{ credential: { id: string; keyId: string } }>()
      .credential

    const exposedSecretRoute = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        name: "exposed-secret-feed",
        secretQueryBindings: { token: credential.id },
        sourceURL: "rsshub://example/private-feed?token=should-not-be-stored",
      },
      url: "/v1/admin/routes",
    })
    expect(exposedSecretRoute.statusCode).toBe(400)
    expect(exposedSecretRoute.json()).toMatchObject({ code: "source_secret_in_logical_url" })

    const routeResponse = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        name: "private-feed",
        secretQueryBindings: { token: credential.id },
        sourceURL: "rsshub://example/private-feed",
      },
      url: "/v1/admin/routes",
    })
    expect(routeResponse.statusCode).toBe(201)
    const route = routeResponse.json<{ route: { id: string } }>().route

    const feedResponse = await server.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET",
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Fprivate-feed",
    })
    expect(feedResponse.statusCode).toBe(200)
    expect(feedResponse.headers["x-folo-upstream-url"]).toBe(
      "http://rsshub:1200/example/private-feed",
    )
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      new URL(
        "http://rsshub:1200/example/private-feed?token=secret-42&key=rsshub-access-key-11111111111111111111",
      ),
      expect.objectContaining({ redirect: "manual" }),
    )

    const routeTest = await server.inject({
      headers: adminHeaders,
      method: "POST",
      url: `/v1/admin/routes/${route.id}/test`,
    })
    expect(routeTest.statusCode).toBe(200)
    expect(routeTest.json()).toMatchObject({
      contentType: "application/rss+xml",
      upstreamStatus: 200,
      upstreamURL: "http://rsshub:1200/example/private-feed",
    })
    expect(routeTest.body).not.toContain("secret-42")

    const inUse = await server.inject({
      headers: adminHeaders,
      method: "DELETE",
      url: `/v1/admin/credentials/${credential.id}`,
    })
    expect(inUse.statusCode).toBe(409)

    const disabledRoute = await server.inject({
      headers: adminHeaders,
      method: "PATCH",
      payload: { enabled: false },
      url: `/v1/admin/routes/${route.id}`,
    })
    expect(disabledRoute.statusCode).toBe(200)
    const disabledCredential = await server.inject({
      headers: adminHeaders,
      method: "DELETE",
      url: `/v1/admin/credentials/${credential.id}`,
    })
    expect(disabledCredential.statusCode).toBe(204)

    const audit = await server.inject({
      headers: adminHeaders,
      method: "GET",
      url: "/v1/admin/audit",
    })
    expect(audit.statusCode).toBe(200)
    expect(audit.body).not.toContain("secret-42")
    expect(audit.json<{ events: unknown[] }>().events).toHaveLength(5)

    const verification = await server.inject({
      headers: adminHeaders,
      method: "GET",
      url: "/v1/admin/audit/verify",
    })
    expect(verification.json()).toEqual({
      brokenAtSequence: null,
      checkedEvents: 5,
      valid: true,
    })

    await server.close()
  })

  it("rejects unregistered routes in managed-only mode", async () => {
    const managedConfig = loadFeedSupplierConfig({
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
      ROUTE_REGISTRY_MODE: "managed_only",
      RSSHUB_BASE_URL: "http://rsshub:1200",
    })
    const fetchImplementation = vi.fn<typeof fetch>()
    const server = await buildFeedSupplier({ config: managedConfig, fetchImplementation })
    const response = await server.inject({
      headers: { authorization: `Bearer ${managedConfig.internalToken}` },
      method: "GET",
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Funregistered",
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: "source_not_registered" })
    expect(fetchImplementation).not.toHaveBeenCalled()
    await server.close()
  })

  it("keeps bound secrets out of upstream failure responses", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error("connect failed for http://rsshub/private?token=never-return-this-secret"),
      )
    const server = await buildFeedSupplier({ config, fetchImplementation })
    const credentialResponse = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: { name: "failure-secret", value: "never-return-this-secret" },
      url: "/v1/admin/credentials",
    })
    const credentialId = credentialResponse.json<{ credential: { id: string } }>().credential.id
    await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        name: "failure-route",
        secretQueryBindings: { token: credentialId },
        sourceURL: "rsshub://example/failure",
      },
      url: "/v1/admin/routes",
    })

    const response = await server.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET",
      url: "/v1/feeds/rsshub?url=rsshub%3A%2F%2Fexample%2Ffailure",
    })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({
      code: "rsshub_request_failed",
      message: "RSSHub request failed",
    })
    expect(response.body).not.toContain("never-return-this-secret")
    await server.close()
  })
})

describe("credential cipher", () => {
  it("supports historical keys and rejects tampered ciphertext", () => {
    const oldKey = Buffer.alloc(32, 1)
    const currentKey = Buffer.alloc(32, 2)
    const encrypted = new CredentialCipher("old", new Map([["old", oldKey]])).encrypt(
      "8bd44f7a-84d2-4b0c-b052-3cdacbfc3919",
      "private-value",
    )
    const cipher = new CredentialCipher(
      "current",
      new Map([
        ["old", oldKey],
        ["current", currentKey],
      ]),
    )

    expect(cipher.decrypt("8bd44f7a-84d2-4b0c-b052-3cdacbfc3919", encrypted)).toBe("private-value")
    expect(() =>
      cipher.decrypt("8bd44f7a-84d2-4b0c-b052-3cdacbfc3919", {
        ...encrypted,
        authenticationTag: Buffer.alloc(16),
      }),
    ).toThrow()
  })
})
