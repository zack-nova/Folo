import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it } from "vitest"

import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { buildServer } from "../src/server"

const feedURL = "https://feeds.example.com/readability.xml"
const articleURL = "https://news.example.com/articles/independent-reader"
const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Readable feed</title><link>https://news.example.com</link>
<item><guid>readable-entry</guid><title>Readable entry</title><link>${articleURL}</link>
<description><![CDATA[<p>Short feed summary</p>]]></description></item>
</channel></rss>`
const article = `<!doctype html><html><head><title>Independent reader</title></head><body>
  <nav>Navigation must be removed</nav>
  <article><h1>The complete independent reader article</h1>
  ${Array.from(
    { length: 10 },
    (_, index) =>
      `<p>Section ${index + 1}. ${"This is the complete article body with useful implementation detail. ".repeat(4)}</p>`,
  ).join("\n")}
  </article>
</body></html>`

describe("entry readability cache", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("extracts safe fetched HTML once and reuses the stored result", async () => {
    let articleFetches = 0
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "readability-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const server = await buildServer({
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore: new MemoryDataStore(),
      feedFetcher: {
        fetch: async (url) => ({
          body: rss,
          contentType: "application/rss+xml",
          etag: null,
          lastModified: null,
          url,
        }),
      },
      readabilityFetcher: {
        fetch: async (url) => {
          articleFetches += 1
          return {
            body: article,
            contentType: "text/html; charset=utf-8",
            etag: null,
            lastModified: null,
            url,
          }
        },
      },
    })
    servers.push(server)

    const registration = await server.inject({
      method: "POST",
      url: "/better-auth/sign-up/email",
      headers: { origin: "http://localhost:2233" },
      payload: {
        email: "readability@example.com",
        name: "Readable Owner",
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
          method: request.method as "GET" | "POST",
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

    await client.api.subscriptions.create({ url: feedURL, view: 0 })
    const entries = await client.api.entries.list({ view: 0 })
    const entryId = entries.data.at(0)!.entries.id

    const first = await client.api.entries.readability({ id: entryId })
    const second = await client.api.entries.readability({ id: entryId })
    expect(first.data?.content).toContain("This is the complete article body")
    expect(first.data?.content).not.toContain("Navigation must be removed")
    expect(second).toEqual(first)
    expect(articleFetches).toBe(1)
  })
})
