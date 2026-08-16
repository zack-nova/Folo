import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { FollowClient } from "@follow-app/client-sdk"
import { afterAll, describe, expect, it } from "vitest"

import { createAuth } from "../src/auth"
import { PostgresDataStore } from "../src/data/postgres-store"
import { createPostgresDatabase } from "../src/db/database"
import { migrateDatabase } from "../src/db/migrate"
import { buildServer } from "../src/server"

const databaseURL = process.env.TEST_DATABASE_URL
const fixturePath = fileURLToPath(new URL("fixtures/phase-one.rss.xml", import.meta.url))

describe.runIf(databaseURL)("PostgreSQL authority", () => {
  const database = createPostgresDatabase(databaseURL!)

  afterAll(async () => {
    await database.pool.end()
  })

  it("keeps a subscription available after the API server is rebuilt", async () => {
    const feedXML = await readFile(fixturePath, "utf8")
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: database.pool,
      secret: "phase-one-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    await migrateDatabase({ auth, database: database.db })

    const feedURL = `https://feeds.example.com/rss.xml?run=${randomUUID()}`
    let server = await buildServer({
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new PostgresDataStore(database.db),
      feedFetcher: {
        fetch: async (url) => ({
          body: feedXML,
          contentType: "application/rss+xml",
          etag: null,
          lastModified: null,
          url,
        }),
      },
    })

    const registration = await server.inject({
      method: "POST",
      url: "/better-auth/sign-up/email",
      headers: { origin: "http://localhost:2233" },
      payload: {
        email: `reader-${randomUUID()}@example.com`,
        name: "Persistent Reader",
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
          method: request.method as "DELETE" | "GET" | "PATCH" | "POST",
          url: new URL(request.url).pathname + new URL(request.url).search,
          headers: { ...Object.fromEntries(request.headers.entries()), cookie: cookie! },
          payload:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : await request.text(),
        })
        return new Response(response.body, {
          status: response.statusCode,
          headers: response.headers as unknown as HeadersInit,
        })
      },
    })

    const created = await client.api.subscriptions.create({ url: feedURL, view: 0 })
    await server.close()

    server = await buildServer({
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new PostgresDataStore(database.db),
      feedFetcher: {
        fetch: async () => {
          throw new Error("Persisted reads must not refetch the feed")
        },
      },
    })

    const subscriptions = await client.api.subscriptions.get({ view: 0 })
    expect(subscriptions.data).toContainEqual(
      expect.objectContaining({ feedId: created.feed!.id, userId: registration.json().user.id }),
    )

    await server.close()
  })
})
