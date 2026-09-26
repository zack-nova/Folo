import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
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
const collectionCursor = (createdAt: Date | string) =>
  typeof createdAt === "string" ? createdAt : createdAt.toISOString()

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
      allowPublicRegistration: true,
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
      allowPublicRegistration: true,
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

    const pageEntries = async (query: Parameters<typeof client.api.entries.list>[0]) =>
      (
        await client.api.entries.list({ feedId: created.feed!.id, limit: 1, view: 0, ...query })
      ).data.map((item) => item.entries)
    const [newest] = await pageEntries({})
    const [oldest] = await pageEntries({ read: false, sortOrder: "asc" })
    expect(newest?.title).toBe("Second entry")
    expect(oldest?.title).toBe("First entry")
    expect(
      (await pageEntries({ publishedAfter: newest!.publishedAt })).map((entry) => entry.title),
    ).toEqual(["First entry"])
    expect(
      (
        await pageEntries({ publishedBefore: oldest!.publishedAt, read: false, sortOrder: "asc" })
      ).map((entry) => entry.title),
    ).toEqual(["Second entry"])

    await client.api.collections.post({ entryId: newest!.id, view: 0 })
    await delay(10)
    await client.api.collections.post({ entryId: oldest!.id, view: 0 })
    const firstCollectionPage = await client.api.entries.list({
      isCollection: true,
      limit: 1,
      view: 0,
    })
    const secondCollectionPage = await client.api.entries.list({
      isCollection: true,
      limit: 1,
      publishedAfter: collectionCursor(firstCollectionPage.data[0]!.collections!.createdAt),
      view: 0,
    })
    const thirdCollectionPage = await client.api.entries.list({
      isCollection: true,
      limit: 1,
      publishedAfter: collectionCursor(secondCollectionPage.data[0]!.collections!.createdAt),
      view: 0,
    })
    expect(
      [...firstCollectionPage.data, ...secondCollectionPage.data].map((item) => item.entries.id),
    ).toEqual([oldest!.id, newest!.id])
    expect(thirdCollectionPage.data).toEqual([])

    const emptyList = await client.api.lists.create({
      title: "Empty list",
      description: null,
      image: null,
      view: 0,
      fee: 0,
    })
    const emptyListDetail = await client.api.lists.get({ listId: emptyList.data.id })
    expect(emptyListDetail.data).toMatchObject({ feedCount: 0, entries: [] })

    await server.close()
    server = await buildServer({
      aiEncryptionSecret: "postgres-ai-encryption-secret-at-least-32-characters",
      aiProvider: {
        complete: async () => ({
          content: JSON.stringify({
            importance_score: 80,
            timeliness_score: 70,
            relevance_score: 90,
            recommendation_reason: "PostgreSQL keeps the evaluation authoritative.",
            primary_category: "Technology",
            tags: ["postgres"],
          }),
          model: "postgres-test-model",
          usage: { inputTokens: 10, outputTokens: 10 },
        }),
      },
      allowPublicRegistration: true,
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new PostgresDataStore(database.db),
      processingWorkerPollIntervalMs: 5,
    })
    const authenticated = async (
      url: string,
      payload?: Record<string, unknown>,
      method: "GET" | "POST" | "PUT" = "POST",
    ) =>
      server.inject({
        method,
        url,
        headers: { cookie: cookie! },
        ...(payload === undefined ? {} : { payload }),
      })
    await authenticated(
      "/api/extensions/ai/provider",
      {
        api_key: "sk-postgres-persisted-secret",
        base_url: "https://ai.example.com/v1",
        model: "postgres-test-model",
      },
      "PUT",
    )
    await authenticated("/api/extensions/profiles", {
      content: { interests: ["PostgreSQL"] },
      name: "default",
    })
    await authenticated("/api/extensions/taxonomies", {
      content: { categories: ["Technology"] },
      name: "default",
    })
    const entryId = (await client.api.entries.list({ view: 0 })).data.at(0)!.entries.id
    const queued = await authenticated("/api/extensions/processing/jobs", { entry_id: entryId })
    const jobId = queued.json().data.job.id as string
    for (let index = 0; index < 100; index += 1) {
      const job = await authenticated(`/api/extensions/processing/jobs/${jobId}`, undefined, "GET")
      if (job.json().data.status === "succeeded") break
      await delay(10)
    }

    await server.close()
    server = await buildServer({
      aiEncryptionSecret: "postgres-ai-encryption-secret-at-least-32-characters",
      allowPublicRegistration: true,
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new PostgresDataStore(database.db),
    })
    const persistedEvaluation = await authenticated(
      `/api/extensions/entries/${entryId}/evaluation`,
      undefined,
      "GET",
    )
    expect(persistedEvaluation.json()).toMatchObject({
      code: 0,
      data: { current: { overall_score: 83, tags: ["postgres"] } },
    })
    const persistedProvider = await authenticated("/api/extensions/ai/provider", undefined, "GET")
    expect(persistedProvider.body).not.toContain("sk-postgres-persisted-secret")
    expect(persistedProvider.json()).toMatchObject({
      code: 0,
      data: { configured: true, key_hint: "…cret", key_source: "stored" },
    })
    await server.close()
  })
})
