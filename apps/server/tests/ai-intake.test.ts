import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AIProvider } from "../src/ai/provider"
import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import { importAIPreset, parseAIPreset } from "../src/processing/ai-preset"
import { entryPromptText } from "../src/processing/entry-text"
import { buildServer } from "../src/server"

const day = 86_400_000
const rss = (
  title: string,
  items: { guid: string; title: string; ageDays: number; html: string }[],
) =>
  `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>${title}</title><link>https://example.gov.cn/</link>
${items
  .map(
    (item) => `<item><guid>${item.guid}</guid><title>${item.title}</title>
<link>https://example.gov.cn/${item.guid}.html</link>
<pubDate>${new Date(Date.now() - item.ageDays * day).toUTCString()}</pubDate>
<content:encoded><![CDATA[${item.html}]]></content:encoded></item>`,
  )
  .join("\n")}
</channel></rss>`

const evaluation = JSON.stringify({
  importance_score: 80,
  primary_category: "政治社会",
  recommendation_reason: "与产业政策相关",
  relevance_score: 90,
  secondary_category: "时政社会",
  summary: "摘要",
  tags: ["政策"],
  timeliness_score: 70,
})

describe("entry prompt text", () => {
  it("drops markup and scripts, keeps paragraph breaks and bounds the length", () => {
    expect(
      entryPromptText(
        "<p>第一条&nbsp;本办法&amp;细则</p><script>track()</script><div>第二条</div><!-- hidden -->",
        100,
      ),
    ).toBe("第一条 本办法&细则\n第二条")
    expect(entryPromptText(`<p>${"通".repeat(50)}</p>`, 10)).toBe(
      `${"通".repeat(10)}\n[Content truncated]`,
    )
    expect(entryPromptText("<img src=x>", 10)).toBeNull()
  })
})

describe("AI intake of subscribed sources", () => {
  const servers: Array<{ close: () => Promise<void> }> = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("scopes evaluation by feed category and age and gives the model bounded source context", async () => {
    const complete = vi.fn<AIProvider["complete"]>().mockResolvedValue({
      content: evaluation,
      model: "reader-model",
      usage: { inputTokens: 30, outputTokens: 20 },
    })
    const feeds: Record<string, string> = {
      "https://feeds.example.gov.cn/policy.xml": rss("国家发展改革委通知", [
        { ageDays: 1, guid: "policy-new", html: `<p>${"政".repeat(3000)}</p>`, title: "新通知" },
        {
          ageDays: 20,
          guid: "policy-old",
          html: "<p>申报截止日期 10 月 30 日</p>",
          title: "旧通知",
        },
        { ageDays: 60, guid: "policy-stale", html: "<p>往年通知</p>", title: "过期通知" },
      ]),
      "https://feeds.example.com/blog.xml": rss("Blog", [
        { ageDays: 1, guid: "blog-new", html: "<p>New post</p>", title: "New post" },
        { ageDays: 20, guid: "blog-old", html: "<p>Old post</p>", title: "Old post" },
      ]),
    }
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "ai-intake-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const dataStore = new MemoryDataStore()
    const server = await buildServer({
      aiProvider: { complete },
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore,
      feedFetcher: {
        fetch: async (url) => ({
          body: feeds[url]!,
          contentType: "application/rss+xml",
          etag: null,
          lastModified: null,
          url,
        }),
      },
      processingMaxAttempts: 1,
      processingMaxContentCharacters: 1_000,
      processingWorkerPollIntervalMs: 5,
    })
    servers.push(server)
    const registration = await server.inject({
      headers: { origin: "http://localhost:2233" },
      method: "POST",
      payload: {
        email: "owner@example.com",
        name: "Owner",
        password: "correct-horse-battery-staple",
      },
      url: "/better-auth/sign-up/email",
    })
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]!
    const ownerId = (await dataStore.getOwnerUserId())!

    const preset = parseAIPreset(
      await readFile(new URL("fixtures/ai.example.json", import.meta.url), "utf8"),
    )
    await importAIPreset(dataStore, ownerId, preset, {
      apply: true,
      profileDocument: "# 个人信息\n关注产业政策与 AI 工具。",
    })

    const client = new FollowClient({
      baseURL: "http://localhost:3000",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const response = await server.inject({
          headers: { ...Object.fromEntries(request.headers.entries()), cookie },
          method: request.method as "GET" | "POST",
          payload: request.method === "GET" ? undefined : await request.text(),
          url: new URL(request.url).pathname + new URL(request.url).search,
        })
        return new Response(response.body, {
          headers: response.headers as unknown as HeadersInit,
          status: response.statusCode,
        })
      },
    })
    await client.api.subscriptions.create({
      category: "政治社会",
      url: "https://feeds.example.gov.cn/policy.xml",
      view: 0,
    })
    await client.api.subscriptions.create({ url: "https://feeds.example.com/blog.xml", view: 0 })

    const titles = new Set(["新通知", "旧通知", "New post"])
    for (let index = 0; index < 100 && complete.mock.calls.length < titles.size; index += 1) {
      await delay(10)
    }
    await delay(50)
    const prompts = complete.mock.calls.map(([request]) => JSON.parse(request.user))
    // 7 days for every feed, 30 days for 政治社会: the 20-day policy notice is still evaluated.
    expect(new Set(prompts.map((prompt) => prompt.entry.title))).toEqual(titles)

    const policy = prompts.find((prompt) => prompt.entry.title === "新通知")
    expect(policy.source).toEqual({
      category: "政治社会",
      feed_title: "国家发展改革委通知",
      site_url: "https://example.gov.cn/",
    })
    expect(policy.entry.content).toMatch(/^政+\n\[Content truncated\]$/)
    expect([...policy.entry.content.replace("\n[Content truncated]", "")]).toHaveLength(1_000)
    expect(policy.profile).toEqual({ document: "# 个人信息\n关注产业政策与 AI 工具。" })
    expect(policy.taxonomy.categories.map((category: { name: string }) => category.name)).toContain(
      "政治社会",
    )
  })
})

describe("AI preset import", () => {
  it("is a dry run by default, adds only missing rules and reuses unchanged snapshots", async () => {
    const dataStore = new MemoryDataStore()
    const userId = "owner"
    await dataStore.setActionRules(userId, [
      { condition: [], name: "AI 评估最近 7 天的新条目", result: { evaluate: {}, custom: true } },
    ])
    const preset = parseAIPreset(
      await readFile(new URL("fixtures/ai.example.json", import.meta.url), "utf8"),
    )

    const planned = await importAIPreset(dataStore, userId, preset, {
      apply: false,
      profileDocument: "profile",
    })
    expect(planned).toMatchObject({
      profile: { status: "planned" },
      taxonomy: { status: "planned" },
    })
    expect(await dataStore.listProcessingTaxonomySnapshots(userId)).toHaveLength(0)

    const applied = await importAIPreset(dataStore, userId, preset, {
      apply: true,
      profileDocument: "profile",
    })
    expect(applied).toEqual({
      actionRules: [
        { name: "AI 评估最近 7 天的新条目", status: "exists" },
        { name: "优先评估政策与公告", status: "added" },
      ],
      profile: { status: "created", version: 1 },
      taxonomy: { status: "created", version: 1 },
    })
    const rules = (await dataStore.getActionRules(userId))!.rules
    expect(rules).toHaveLength(2)
    expect(rules[0]).toMatchObject({ result: { custom: true } })

    const rerun = await importAIPreset(dataStore, userId, preset, {
      apply: true,
      profileDocument: "profile",
    })
    expect(rerun).toMatchObject({
      profile: { status: "unchanged", version: 1 },
      taxonomy: { status: "unchanged", version: 1 },
    })
    expect(
      await importAIPreset(dataStore, userId, preset, { apply: true, profileDocument: null }),
    ).toMatchObject({ profile: { status: "skipped" } })
  })

  it("rejects presets with duplicate rule names or unknown fields", () => {
    const base = {
      actionRules: [],
      description: "test",
      profile: { name: "p" },
      taxonomy: { content: { categories: [{ name: "A", subcategories: [] }] }, name: "t" },
    }
    const rule = { condition: [], name: "same", result: { evaluate: {} } }
    expect(() => parseAIPreset(JSON.stringify({ ...base, actionRules: [rule, rule] }))).toThrow(
      "unique",
    )
    expect(() =>
      parseAIPreset(JSON.stringify({ ...base, profile: { document: "x", name: "p" } })),
    ).toThrow()
  })
})

describe("entry prompt text review regressions", () => {
  it("keeps literal angle brackets, decodes named entities and joins inline markup", () => {
    expect(entryPromptText("<p>x < 3 and y > 1</p>", 100)).toBe("x < 3 and y > 1")
    expect(entryPromptText("<p>Caf&eacute; &mdash; &Eacute;t&eacute;</p>", 100)).toBe("Café — Été")
    expect(entryPromptText('<p>foo<b>bar</b><a title="a > b" href="/x">baz</a></p>', 100)).toBe(
      "foobarbaz",
    )
  })

  it("stays linear on hostile markup", () => {
    const hostile = "<script>".repeat(40_000)
    const started = performance.now()
    expect(entryPromptText(hostile, 12_000)).toBeNull()
    expect(entryPromptText(`<p>${"a<b>".repeat(80_000)}</p>`, 12_000)).toMatch(/Content truncated/)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe("AI intake age fallback", () => {
  const servers: Array<{ close: () => Promise<void> }> = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("ages undated entries by when they were first stored", async () => {
    const complete = vi.fn<AIProvider["complete"]>().mockResolvedValue({
      content: evaluation,
      model: "reader-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    const undated = `<?xml version="1.0"?><rss version="2.0"><channel><title>Undated</title>
<link>https://example.com/</link><item><guid>undated</guid><title>Undated notice</title>
<link>https://example.com/undated</link><description>No date</description></item></channel></rss>`
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "ai-intake-age-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const dataStore = new MemoryDataStore()
    const server = await buildServer({
      aiProvider: { complete },
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore,
      feedFetcher: {
        fetch: async (url) => ({
          body: undated,
          contentType: "application/rss+xml",
          etag: null,
          lastModified: null,
          url,
        }),
      },
      processingMaxAttempts: 1,
      processingWorkerPollIntervalMs: 5,
    })
    servers.push(server)
    const registration = await server.inject({
      headers: { origin: "http://localhost:2233" },
      method: "POST",
      payload: {
        email: "owner@example.com",
        name: "Owner",
        password: "correct-horse-battery-staple",
      },
      url: "/better-auth/sign-up/email",
    })
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]!
    const owner = { cookie, origin: "http://localhost:2233" }
    const ownerId = (await dataStore.getOwnerUserId())!
    const preset = parseAIPreset(
      await readFile(new URL("fixtures/ai.example.json", import.meta.url), "utf8"),
    )
    await importAIPreset(dataStore, ownerId, preset, { apply: true, profileDocument: "v1" })

    const subscribed = await server.inject({
      headers: owner,
      method: "POST",
      payload: { url: "https://example.com/undated.xml", view: 0 },
      url: "/subscriptions",
    })
    expect(subscribed.statusCode, subscribed.body).toBe(200)
    for (let index = 0; index < 100 && complete.mock.calls.length === 0; index += 1) await delay(10)
    expect(complete).toHaveBeenCalledTimes(1)

    // The entry was first stored 30 days ago; a new profile makes it eligible again.
    const entries = (dataStore as unknown as { entries: Map<string, { insertedAt: Date }> }).entries
    for (const entry of entries.values()) entry.insertedAt = new Date(Date.now() - 30 * day)
    await importAIPreset(dataStore, ownerId, preset, { apply: true, profileDocument: "v2" })
    const [feedId] = (await dataStore.listSubscriptions(ownerId)).map((item) => item.feedId)
    const refreshed = await server.inject({
      headers: owner,
      method: "POST",
      url: `/api/extensions/operations/feeds/${feedId}/retry`,
    })
    expect(refreshed.statusCode).toBe(202)
    await delay(100)
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

describe("AI preset import review regressions", () => {
  it("rejects an empty profile and retries when rules change underneath it", async () => {
    const dataStore = new MemoryDataStore()
    const preset = parseAIPreset(
      await readFile(new URL("fixtures/ai.example.json", import.meta.url), "utf8"),
    )
    await expect(
      importAIPreset(dataStore, "owner", preset, { apply: true, profileDocument: "  \n" }),
    ).rejects.toThrow("empty")
    expect(await dataStore.listProcessingProfileSnapshots("owner")).toHaveLength(0)

    const concurrentRule = { condition: [], name: "Owner rule", result: { readability: true } }
    const write = dataStore.setActionRulesIfUnchanged.bind(dataStore)
    vi.spyOn(dataStore, "setActionRulesIfUnchanged").mockImplementationOnce(async (...args) => {
      // The owner saves a rule just before the import writes.
      await dataStore.setActionRules("owner", [concurrentRule])
      return write(...args)
    })

    await importAIPreset(dataStore, "owner", preset, { apply: true, profileDocument: null })

    expect((await dataStore.getActionRules("owner"))!.rules.map((rule) => rule.name)).toEqual([
      "Owner rule",
      "AI 评估最近 7 天的新条目",
      "优先评估政策与公告",
    ])
  })
})
