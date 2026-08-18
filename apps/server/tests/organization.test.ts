import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it } from "vitest"

import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

const fixturePath = fileURLToPath(new URL("fixtures/phase-one.rss.xml", import.meta.url))

describe("subscription organization", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("organizes subscribed feeds with categories and an owner list", async () => {
    const feedXML = await readFile(fixturePath, "utf8")
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "organization-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new MemoryDataStore(),
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
    servers.push(server)

    const registration = await server.inject({
      method: "POST",
      url: "/better-auth/sign-up/email",
      headers: { origin: "http://localhost:2233" },
      payload: {
        email: "organizer@example.com",
        name: "Organizer",
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

    const createdFeed = await client.api.subscriptions.create({
      url: "https://feeds.example.com/organization.xml",
      view: 0,
      category: "Old category",
    })
    const feedId = createdFeed.feed!.id

    await client.api.categories.update({
      feedIdList: [feedId],
      category: "Research",
    })
    expect((await client.api.subscriptions.get({ view: 0 })).data[0]).toMatchObject({
      category: "Research",
      feedId,
    })

    const createdList = await client.api.lists.create({
      title: "Deep reads",
      description: "Long-form research",
      image: null,
      view: 0,
      fee: 0,
    })
    expect(createdList.data).toMatchObject({
      title: "Deep reads",
      ownerUserId: registration.json().user.id,
      feedIds: [],
    })

    const addedFeeds = await client.api.lists.addFeeds({
      listId: createdList.data.id,
      feedIds: [feedId],
    })
    expect(addedFeeds.data).toEqual([expect.objectContaining({ id: feedId })])

    const detail = await client.api.lists.get({ listId: createdList.data.id })
    expect(detail.data).toMatchObject({
      list: {
        id: createdList.data.id,
        feedIds: [feedId],
        feeds: [expect.objectContaining({ id: feedId })],
      },
      feedCount: 1,
      subscriptionCount: 1,
      entries: expect.arrayContaining([
        expect.objectContaining({
          feeds: expect.objectContaining({ id: feedId }),
          title: "Second entry",
        }),
      ]),
    })
    expect((await client.api.lists.list({})).data).toEqual([
      expect.objectContaining({ id: createdList.data.id, feedIds: [feedId] }),
    ])

    const subscriptions = await client.api.subscriptions.get({ view: 0 })
    expect(subscriptions.data).toContainEqual(
      expect.objectContaining({
        listId: createdList.data.id,
        lists: expect.objectContaining({ id: createdList.data.id }),
      }),
    )

    await client.api.lists.update({
      listId: createdList.data.id,
      title: "Renamed deep reads",
      view: 1,
    })
    expect((await client.api.lists.list({})).data[0]).toMatchObject({
      title: "Renamed deep reads",
      view: 1,
    })

    await client.api.lists.removeFeed({ listId: createdList.data.id, feedId })
    expect((await client.api.lists.get({ listId: createdList.data.id })).data).toMatchObject({
      feedCount: 0,
      entries: [],
    })

    await client.api.categories.delete({
      feedIdList: [feedId],
      deleteSubscriptions: false,
    })
    expect((await client.api.subscriptions.get({})).data).toContainEqual(
      expect.objectContaining({ feedId, category: null }),
    )

    await client.api.lists.delete({ listId: createdList.data.id })
    expect((await client.api.lists.list({})).data).toEqual([])
  })
})
