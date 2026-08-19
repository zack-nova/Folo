import { randomUUID } from "node:crypto"

import { Pool } from "pg"
import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import { PageFetcher } from "../src/page-fetcher"
import { PostgresSupplierRepository } from "../src/postgres-repository"
import { buildFeedSupplier } from "../src/server"

const databaseURL = process.env.TEST_FEED_SUPPLIER_DATABASE_URL

describe.skipIf(!databaseURL)("PostgreSQL source registry", () => {
  it("migrates and retains credentials, routes, and a valid audit chain across restarts", async () => {
    const suffix = randomUUID()
    const firstConfig = loadFeedSupplierConfig({
      CREDENTIAL_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      CREDENTIAL_ENCRYPTION_KEY_ID: "old-key",
      DATABASE_URL: databaseURL,
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
      RSSHUB_BASE_URL: "http://rsshub:1200",
    })
    const createRepository = (config: typeof firstConfig) =>
      new PostgresSupplierRepository({
        auditKey: config.auditHmacKey,
        connectionString: databaseURL!,
        maxConnections: 2,
      })
    const pageFetcher = new PageFetcher({
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("<main>Initial page value</main>", {
          headers: { "content-type": "text/html" },
        }),
      ),
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      maxBytes: 1024 * 1024,
      maxContentBytes: 256 * 1024,
      timeoutMs: 5_000,
    })

    const firstServer = await buildFeedSupplier({
      config: firstConfig,
      pageFetcher,
      repository: createRepository(firstConfig),
    })
    const headers = { authorization: `Bearer ${firstConfig.adminToken}` }
    const credentialResponse = await firstServer.inject({
      headers,
      method: "POST",
      payload: { name: `postgres-credential-${suffix}`, value: "database-secret" },
      url: "/v1/admin/credentials",
    })
    expect(credentialResponse.statusCode).toBe(201)
    const credentialId = credentialResponse.json<{ credential: { id: string } }>().credential.id
    const routeResponse = await firstServer.inject({
      headers,
      method: "POST",
      payload: {
        name: `postgres-route-${suffix}`,
        secretQueryBindings: { token: credentialId },
        sourceURL: `rsshub://integration/${suffix}`,
      },
      url: "/v1/admin/routes",
    })
    expect(routeResponse.statusCode).toBe(201)
    const routeId = routeResponse.json<{ route: { id: string } }>().route.id
    const pageSourceResponse = await firstServer.inject({
      headers,
      method: "POST",
      payload: {
        contentSelector: "main",
        name: `postgres-page-${suffix}`,
        targetURL: `https://example.com/${suffix}`,
      },
      url: "/v1/admin/page-sources",
    })
    expect(pageSourceResponse.statusCode).toBe(201)
    const pageSourceId = pageSourceResponse.json<{ source: { id: string } }>().source.id
    expect(
      (
        await firstServer.inject({
          headers,
          method: "POST",
          url: `/v1/admin/page-sources/${pageSourceId}/check`,
        })
      ).json(),
    ).toMatchObject({ status: "initial_published" })
    await firstServer.close()

    const secondConfig = loadFeedSupplierConfig({
      CREDENTIAL_DECRYPTION_KEYS_JSON: '{"old-key":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="}',
      CREDENTIAL_ENCRYPTION_KEY: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
      CREDENTIAL_ENCRYPTION_KEY_ID: "current-key",
      DATABASE_URL: databaseURL,
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
      RSSHUB_BASE_URL: "http://rsshub:1200",
    })
    const secondServer = await buildFeedSupplier({
      config: secondConfig,
      pageFetcher,
      repository: createRepository(secondConfig),
    })
    const rotation = await secondServer.inject({
      headers,
      method: "POST",
      url: "/v1/admin/credentials/rotate",
    })
    expect(rotation.json()).toEqual({ rotatedCount: 1 })
    const credentials = await secondServer.inject({
      headers,
      method: "GET",
      url: "/v1/admin/credentials",
    })
    const persistedCredential = credentials
      .json<{ credentials: Array<{ id: string; keyId: string }> }>()
      .credentials.find((credential) => credential.id === credentialId)
    expect(persistedCredential).toMatchObject({ id: credentialId, keyId: "current-key" })
    const routes = await secondServer.inject({ headers, method: "GET", url: "/v1/admin/routes" })
    expect(routes.body).toContain(`rsshub://integration/${suffix}`)
    const pageSources = await secondServer.inject({
      headers,
      method: "GET",
      url: "/v1/admin/page-sources",
    })
    expect(pageSources.body).toContain(pageSourceId)
    expect(pageSources.json<{ sources: Array<{ eventCount: number }> }>().sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventCount: 1 })]),
    )
    const verification = await secondServer.inject({
      headers,
      method: "GET",
      url: "/v1/admin/audit/verify",
    })
    expect(verification.json()).toMatchObject({ brokenAtSequence: null, valid: true })

    const directDatabase = new Pool({ connectionString: databaseURL })
    const storedCredential = await directDatabase.query<{ ciphertext: Buffer }>(
      "select ciphertext from source_credentials where id = $1",
      [credentialId],
    )
    expect(storedCredential.rows[0]?.ciphertext.toString("utf8")).not.toContain("database-secret")
    await expect(
      directDatabase.query("update source_audit_events set actor = actor where resource_id = $1", [
        routeId,
      ]),
    ).rejects.toThrow("source_audit_events is append-only")
    await expect(
      directDatabase.query("update page_change_events set title = title where source_id = $1", [
        pageSourceId,
      ]),
    ).rejects.toThrow("page_change_events is immutable")
    await directDatabase.end()

    expect(
      (
        await secondServer.inject({
          headers,
          method: "DELETE",
          url: `/v1/admin/routes/${routeId}`,
        })
      ).statusCode,
    ).toBe(204)
    expect(
      (
        await secondServer.inject({
          headers,
          method: "DELETE",
          url: `/v1/admin/page-sources/${pageSourceId}`,
        })
      ).statusCode,
    ).toBe(204)
    expect(
      (
        await secondServer.inject({
          headers,
          method: "DELETE",
          url: `/v1/admin/credentials/${credentialId}`,
        })
      ).statusCode,
    ).toBe(204)
    await secondServer.close()
  })
})
