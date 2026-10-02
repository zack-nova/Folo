import { randomUUID } from "node:crypto"

import { Pool } from "pg"
import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import { PostgresSupplierRepository } from "../src/postgres-repository"
import { WebListFetcher } from "../src/web-list-fetcher"
import { WebListService } from "../src/web-list-service"

const databaseURL = process.env.TEST_FEED_SUPPLIER_DATABASE_URL

describe.skipIf(!databaseURL)("PostgreSQL web list repository", () => {
  it("persists extraction, inserts on conflict, enforces immutability and orders the feed", async () => {
    // Share the audit key of the other PostgreSQL tests so the common hash chain stays valid.
    const { auditHmacKey } = loadFeedSupplierConfig({
      DATABASE_URL: databaseURL,
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
      RSSHUB_BASE_URL: "http://rsshub:1200",
    })
    const repository = new PostgresSupplierRepository({
      auditKey: auditHmacKey,
      connectionString: databaseURL!,
      maxConnections: 2,
    })
    const database = new Pool({
      connectionString: databaseURL!,
      max: 1,
      connectionTimeoutMillis: 2000,
    })
    try {
      await repository.initialize()
      const fetcher = new WebListFetcher({
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        maxBytes: 4096,
        timeoutMs: 1000,
        requestDelayMs: 0,
        fetchImplementation: vi.fn<typeof fetch>().mockImplementation(
          async () =>
            new Response(
              JSON.stringify([
                { title: "Old", url: "/old", date: "2026-08-01" },
                { title: "New", url: "/new", date: "2026-09-01" },
                { title: "Undated", url: "/undated" },
              ]),
              { headers: { "content-type": "text/plain" } },
            ),
        ),
      })
      const service = new WebListService(repository, fetcher)
      const source = await service.createSource(
        {
          name: `web-list-postgres-${randomUUID()}`,
          targetURL: "https://example.com/list",
          format: "json",
          json: { titlePath: "title", urlPath: "url", publishedAtPath: "date" },
        },
        "postgres-test",
      )
      expect((await repository.findWebListSource(source.id))?.json).toMatchObject({
        titlePath: "title",
        urlPath: "url",
      })
      expect(await service.checkSource(source.id, new Date("2026-09-02T00:00:00Z"))).toMatchObject({
        publishedCount: 3,
      })
      const stored = (await repository.findWebListSource(source.id))!
      const items = await repository.listWebListItems(source.id, 100)
      expect(items.map((item) => item.title)).toEqual(["Undated", "New", "Old"])
      expect(await repository.saveWebListObservation(stored, items)).toMatchObject({ itemCount: 3 })
      expect((await service.listSources()).find((item) => item.id === source.id)?.itemCount).toBe(3)
      expect(
        await repository.findWebListItemKeys(
          source.id,
          items.map((item) => item.itemKey),
        ),
      ).toHaveLength(3)
      await expect(
        database.query("update web_list_items set title = title where source_id = $1", [source.id]),
      ).rejects.toThrow("web_list_items is immutable")
      await expect(
        database.query("delete from web_list_items where source_id = $1", [source.id]),
      ).rejects.toThrow("web_list_items is immutable")
      const first = items[0]!
      await repository.saveWebListObservation(stored, [
        {
          ...first,
          id: randomUUID(),
          itemKey: "f".repeat(64),
          guid: `urn:folo:web-list:${source.id}:${"f".repeat(32)}`,
          title: "Later discovery",
          discoveredAt: "2026-09-03T00:00:00.000Z",
          publishedAt: "2026-09-02T00:00:00.000Z",
        },
      ])
      expect((await repository.listWebListItems(source.id, 2)).map((item) => item.title)).toEqual([
        "Later discovery",
        "Undated",
      ])
      await service.updateSource(
        source.id,
        { name: `${source.name}-updated`, enabled: true, intervalMinutes: 15 },
        "postgres-test",
      )
      expect(
        (await repository.countWebListSources("2099-01-01T00:00:00Z")).due,
      ).toBeGreaterThanOrEqual(1)
      expect(
        (await repository.listDueWebListSources("2099-01-01T00:00:00Z", 100)).some(
          (item) => item.id === source.id,
        ),
      ).toBe(true)
      await service.deleteSource(source.id, "postgres-test")
      expect(await repository.findWebListSource(source.id)).toBeNull()
      expect(await repository.listWebListItems(source.id, 100)).toHaveLength(4)
    } finally {
      await repository.close()
      await database.end()
    }
  })
})
