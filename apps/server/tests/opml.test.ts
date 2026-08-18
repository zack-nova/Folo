import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it } from "vitest"

import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Phase one subscriptions</title></head>
  <body>
    <outline text="Research" title="Research">
      <outline type="rss" text="Alpha" title="Alpha" xmlUrl="https://feeds.example.com/alpha.xml" />
      <outline type="rss" text="Beta" title="Beta" xmlUrl="https://feeds.example.com/beta.xml" />
    </outline>
    <outline type="rss" text="Duplicate Alpha" xmlUrl="https://feeds.example.com/alpha.xml" />
  </body>
</opml>`

const rss = (url: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>${url}</title><link>${url}</link>
<item><guid>${url}-entry</guid><title>Imported entry</title><link>${url}/entry</link></item>
</channel></rss>`

describe("OPML portability", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("previews, imports with conflict reporting, and exports subscriptions", async () => {
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "opml-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new MemoryDataStore(),
      feedFetcher: {
        fetch: async (url) => ({
          body: rss(url),
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
        email: "opml@example.com",
        name: "OPML Owner",
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
              : Buffer.from(await request.arrayBuffer()),
        })
        return new Response(response.body, {
          status: response.statusCode,
          headers: response.headers as unknown as HeadersInit,
        })
      },
    })

    const parsed = await client.api.subscriptions.parseOpml(
      new TextEncoder().encode(opml).buffer as ArrayBuffer,
    )
    expect(parsed.data).toMatchObject({
      remaining: 10_000,
      subscriptions: [
        {
          userId: registration.json().user.id,
          url: "https://feeds.example.com/alpha.xml",
          view: 0,
          category: "Research",
          title: "Alpha",
        },
        {
          userId: registration.json().user.id,
          url: "https://feeds.example.com/beta.xml",
          view: 0,
          category: "Research",
          title: "Beta",
        },
      ],
    })

    await client.api.subscriptions.create({
      url: "https://feeds.example.com/alpha.xml",
      view: 0,
    })

    const formData = new FormData()
    formData.append("file", new Blob([opml], { type: "text/x-opml" }), "subscriptions.opml")
    formData.append(
      "items",
      JSON.stringify(["https://feeds.example.com/alpha.xml", "https://feeds.example.com/beta.xml"]),
    )
    const imported = await client.api.subscriptions.import(formData)
    expect(imported.data).toMatchObject({
      successfulItems: [{ url: "https://feeds.example.com/beta.xml", title: "Beta" }],
      conflictItems: [{ url: "https://feeds.example.com/alpha.xml", title: "Alpha" }],
      parsedErrorItems: [],
    })
    expect((await client.api.subscriptions.get({})).data).toHaveLength(2)

    const exported = await client.api.subscriptions.export({ format: "opml" })
    expect(exported).toMatchObject({
      contentType: "text/x-opml; charset=utf-8",
      filename: "folo-subscriptions.opml",
    })
    expect(exported.content).toContain("https://feeds.example.com/alpha.xml")
    expect(exported.content).toContain("Research")
  })
})
