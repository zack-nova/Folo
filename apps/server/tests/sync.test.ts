import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import type { SyncAction } from "@follow-app/client-sdk"
import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterAll, afterEach, describe, expect, it } from "vitest"

import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { PostgresDataStore } from "../src/data/postgres-store"
import type { DataStore } from "../src/data/types"
import { createPostgresDatabase } from "../src/db/database"
import { migrateDatabase } from "../src/db/migrate"
import { buildServer } from "../src/server"

const fixturePath = fileURLToPath(new URL("fixtures/phase-one.rss.xml", import.meta.url))
const databaseURL = process.env.TEST_DATABASE_URL
const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1_000

const newItem = `<item>
      <guid isPermaLink="false">phase-one-entry-3</guid>
      <title>Third entry</title>
      <link>https://feeds.example.com/third</link>
      <description>Third description</description>
      <pubDate>Sat, 16 Aug 2026 03:00:00 GMT</pubDate>
    </item>
    <item>`

type StoreSetup = () => Promise<{
  auth: ReturnType<typeof createAuth>
  dataStore: DataStore
}>

const memorySetup: StoreSetup = async () => ({
  auth: createAuth({
    baseURL: "http://localhost:3000",
    database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
    secret: "sync-test-secret-that-is-at-least-32-characters",
    trustedOrigins: ["http://localhost:2233"],
  }),
  dataStore: new MemoryDataStore(),
})

const database = databaseURL ? createPostgresDatabase(databaseURL) : null
const postgresSetup: StoreSetup = async () => {
  const auth = createAuth({
    baseURL: "http://localhost:3000",
    database: database!.pool,
    secret: "sync-test-secret-that-is-at-least-32-characters",
    trustedOrigins: ["http://localhost:2233"],
  })
  await migrateDatabase({ auth, database: database!.db })
  return { auth, dataStore: new PostgresDataStore(database!.db) }
}

afterAll(async () => {
  await database?.pool.end()
})

const stores: Array<[string, StoreSetup]> = [
  ["memory", memorySetup],
  ...(database ? [["postgres", postgresSetup] as [string, StoreSetup]] : []),
]

describe.each(stores)("incremental sync (%s store)", (_name, setup) => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  const start = async () => {
    const feedXML = await readFile(fixturePath, "utf8")
    let fetchedXML = feedXML
    const { auth, dataStore } = await setup()
    const server = await buildServer({
      allowPublicRegistration: true,
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore,
      feedFetcher: {
        fetch: async (url) => ({
          body: fetchedXML,
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
        email: `sync-${randomUUID()}@example.com`,
        name: "Sync Reader",
        password: "correct-horse-battery-staple",
      },
    })
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]
    expect(cookie).toBeTruthy()

    const request = async (
      method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
      url: string,
      payload?: unknown,
    ) => {
      const response = await server.inject({
        method,
        url,
        headers: { cookie: cookie!, origin: "http://localhost:2233" },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      })
      return { status: response.statusCode, body: response.json() as Record<string, unknown> }
    }

    const client = new FollowClient({
      baseURL: "http://localhost:3000",
      fetch: async (input, init) => {
        const sdkRequest = new Request(input, init)
        const response = await server.inject({
          method: sdkRequest.method as "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
          url: new URL(sdkRequest.url).pathname + new URL(sdkRequest.url).search,
          headers: {
            ...Object.fromEntries(sdkRequest.headers.entries()),
            cookie: cookie!,
            origin: "http://localhost:2233",
          },
          payload:
            sdkRequest.method === "GET" || sdkRequest.method === "HEAD"
              ? undefined
              : await sdkRequest.text(),
        })
        return new Response(response.body, {
          status: response.statusCode,
          headers: response.headers as unknown as HeadersInit,
        })
      },
    })

    // Reads the log after `cursor` the way the client sync engine does.
    const delta = async (cursor: number, limit?: number) =>
      (await client.api.sync.delta({ lastSyncId: cursor, ...(limit ? { limit } : {}) })).data

    return {
      client,
      dataStore,
      delta,
      request,
      addNewItem: () => {
        fetchedXML = feedXML.replace("<item>", newItem)
      },
    }
  }

  it("records every user-owned change and answers mutations with their sync id", async () => {
    const { addNewItem, client, delta, request } = await start()
    const initial = (await client.api.sync.state()).data.lastSyncId

    const feedURL = `https://feeds.example.com/rss.xml?run=${randomUUID()}`
    const subscribed = await request("POST", "/subscriptions", { url: feedURL, view: 0 })
    const feedId = (subscribed.body.feed as { id: string }).id
    const afterSubscribe = await delta(initial)
    expect(afterSubscribe.actions).toEqual([
      expect.objectContaining({
        model: "subscription",
        modelId: feedId,
        action: "I",
        data: expect.objectContaining({
          feedId,
          view: 0,
          feeds: expect.objectContaining({ id: feedId }),
        }),
      }),
    ])
    expect(subscribed.body.lastSyncId).toBe(afterSubscribe.lastSyncId)
    let cursor = afterSubscribe.lastSyncId

    const entries = await client.api.entries.list({ feedId, view: 0 })
    const [newest, oldest] = entries.data.map((item) => item.entries.id)

    const marked = await request("POST", "/reads", { entryIds: [newest, oldest] })
    const afterRead = await delta(cursor)
    expect(afterRead.actions).toEqual([
      expect.objectContaining({
        model: "timeline",
        action: "U",
        data: { entryIds: [newest, oldest], read: true, isInbox: false, feeds: { [feedId]: 2 } },
      }),
    ])
    expect(marked.body.lastSyncId).toBe(afterRead.lastSyncId)
    cursor = afterRead.lastSyncId

    // Nothing flips a second time, so nothing is logged and the answer names the current id.
    const repeated = await request("POST", "/reads", { entryIds: [newest] })
    expect((await delta(cursor)).actions).toEqual([])
    expect(repeated.body.lastSyncId).toBe(cursor)

    await request("DELETE", "/reads", { entryId: oldest })
    await request("POST", "/collections", { entryId: newest, view: 0 })
    await request("POST", "/collections", { entryId: newest, view: 0 })
    await request("DELETE", "/collections", { entryId: newest })
    await request("PATCH", "/subscriptions", { feedId, category: "Engineering" })
    await request("PUT", "/actions", { rules: [] })
    await request("PATCH", "/settings/general", { unreadOnly: true })
    await request("PATCH", "/settings/ai", { apiKey: "never-logged" })
    const afterEdits = await delta(cursor)
    expect(afterEdits.actions.map(({ model, action }) => `${model}:${action}`)).toEqual([
      "timeline:U",
      "collection:I",
      "collection:D",
      "subscription:U",
      "action:U",
      "setting:U",
      "setting:U",
    ])
    const [unread, starred, , patched, rules, general, ai] = afterEdits.actions as SyncAction[]
    expect(unread!.data).toEqual({
      entryIds: [oldest],
      read: false,
      isInbox: false,
      feeds: { [feedId]: 1 },
    })
    expect(starred!.data).toEqual({
      entryId: newest,
      feedId,
      view: 0,
      createdAt: expect.any(String),
    })
    expect(patched!.data).toEqual({ category: "Engineering" })
    expect(rules!.data).toEqual({ rules: [] })
    expect(general).toMatchObject({
      modelId: "general",
      data: { payload: { unreadOnly: true }, updatedAt: expect.any(String) },
    })
    // Credentials never enter the log; clients read that tab through /settings.
    expect(ai).toMatchObject({ modelId: "ai", data: { updatedAt: expect.any(String) } })
    expect(JSON.stringify(ai)).not.toContain("never-logged")
    cursor = afterEdits.lastSyncId

    // New entries arrive as one coalesced hint per feed, with the numbers counters need.
    addNewItem()
    expect((await request("GET", `/feeds/refresh?id=${feedId}`)).status).toBe(200)
    const afterRefresh = await delta(cursor)
    expect(afterRefresh.actions).toEqual([
      expect.objectContaining({
        model: "timeline",
        modelId: feedId,
        action: "N",
        data: {
          feedId,
          count: 1,
          unread: 1,
          latestPublishedAt: "2026-08-16T03:00:00.000Z",
          from: ["feed"],
        },
      }),
    ])
    cursor = afterRefresh.lastSyncId

    const list = await request("POST", "/lists", { title: "Reading list", view: 0, fee: 0 })
    const listId = (list.body.data as { id: string }).id
    await request("POST", "/lists/feeds", { listId, feedId })
    await request("DELETE", "/lists", { listId })
    await request("DELETE", "/subscriptions", { feedId })
    const afterLists = await delta(cursor)
    expect(afterLists.actions.map(({ model, action }) => `${model}:${action}`)).toEqual([
      "list_subscription:I",
      "list:U",
      "list:D",
      "subscription:D",
    ])
    expect(afterLists.actions[0]!.data).toMatchObject({
      listId,
      lists: expect.objectContaining({ id: listId, owner: expect.objectContaining({}) }),
    })
    expect(afterLists.actions[1]!.data).toEqual({ feedIds: [feedId] })
  })

  it("pages the log and pairs unread snapshots with the sync id they reflect", async () => {
    const { client, delta, request } = await start()
    const feedURL = `https://feeds.example.com/rss.xml?run=${randomUUID()}`
    const subscribed = await request("POST", "/subscriptions", { url: feedURL, view: 0 })
    const feedId = (subscribed.body.feed as { id: string }).id
    const entries = await client.api.entries.list({ feedId, view: 0 })
    for (const item of entries.data) {
      await request("POST", "/reads", { entryIds: [item.entries.id] })
    }

    const state = (await client.api.sync.state()).data.lastSyncId
    const reads = await request("GET", "/reads")
    expect(reads.body).toMatchObject({ code: 0, data: { [feedId]: 0 }, lastSyncId: state })

    const firstPage = await delta(0, 1)
    expect(firstPage.actions).toHaveLength(1)
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.lastSyncId).toBe(firstPage.actions[0]!.id)
    const rest = await delta(firstPage.lastSyncId)
    expect(rest.hasMore).toBe(false)
    expect(rest.lastSyncId).toBe(state)
    expect([...firstPage.actions, ...rest.actions].map((action) => action.model)).toEqual([
      "subscription",
      "timeline",
      "timeline",
    ])
  })

  it("asks clients to take a fresh snapshot when their cursor cannot be served", async () => {
    const { client, dataStore, delta, request } = await start()
    const feedURL = `https://feeds.example.com/rss.xml?run=${randomUUID()}`
    await request("POST", "/subscriptions", { url: feedURL, view: 0 })
    const state = (await client.api.sync.state()).data.lastSyncId

    // A cursor from another database, e.g. before the instance was restored.
    expect(await delta(state + 1_000)).toMatchObject({ actions: [], reset: true })

    // Rows past retention are deleted and raise the floor for older cursors.
    const deleted = await dataStore.cleanupSyncActions(new Date(Date.now() + THIRTY_ONE_DAYS_MS))
    expect(deleted).toBeGreaterThan(0)
    expect(await delta(state - 1)).toMatchObject({ reset: true, lastSyncId: state })
    expect(await delta(state)).toMatchObject({ actions: [], reset: false, lastSyncId: state })
    expect((await client.api.sync.state()).data.lastSyncId).toBe(state)
  })

  it("keeps unknown sync routes on 404 and rejects malformed cursors", async () => {
    const { request } = await start()
    expect((await request("GET", "/sync/unknown")).status).toBe(404)
    expect((await request("GET", "/sync/delta?lastSyncId=-1")).status).toBe(400)
    expect((await request("GET", "/sync/delta")).status).toBe(400)
  })
})
