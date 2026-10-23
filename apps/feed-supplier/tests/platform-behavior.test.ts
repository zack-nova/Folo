import type {
  PlatformBehaviorCheckResult,
  PlatformBehaviorEntry,
  PlatformBehaviorSource,
} from "@follow/feed-source-contracts"
import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import { MemorySupplierRepository } from "../src/memory-repository"
import { PlatformBehaviorError, PlatformBehaviorService } from "../src/platform-behavior-service"
import { BilibiliBehaviorAdapter, bilibiliCookieHeader } from "../src/platforms/bilibili"
import { PostgresSupplierRepository } from "../src/postgres-repository"
import type { SupplierRepository } from "../src/repository"
import { SafeHTTPClient } from "../src/safe-http"
import { buildFeedSupplier } from "../src/server"
import { isolatedDatabaseURL } from "./support/postgres-database"

const ACCOUNT = "12345678"
const SESSDATA = "personal-sessdata-value"
const seconds = (iso: string) => Date.parse(iso) / 1000

interface FakeMedia {
  bvid: string
  fav_time: number
  title: string
  type?: number
}
/** A small stand-in for the three Bilibili endpoints the adapter reads. */
const fakeBilibili = () => {
  const state = {
    code: 0,
    follows: [] as { mid: number; uname: string; mtime: number; sign?: string }[],
    folders: [] as { id: number; title: string; media_count: number }[],
    medias: new Map<number, FakeMedia[]>(),
  }
  const calls: { path: string; page: string | null; cookie: string | null }[] = []
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    calls.push({
      path: url.pathname,
      page: url.searchParams.get("pn"),
      cookie: new Headers(init?.headers).get("cookie"),
    })
    if (state.code) return json({ code: state.code, message: "error", data: null })
    const page = Number(url.searchParams.get("pn") ?? 1)
    const size = Number(url.searchParams.get("ps") ?? 20)
    if (url.pathname === "/x/relation/followings") {
      const sorted = [...state.follows].sort((left, right) => right.mtime - left.mtime)
      return json({
        code: 0,
        data: { list: sorted.slice((page - 1) * size, page * size), total: sorted.length },
      })
    }
    if (url.pathname === "/x/v3/fav/folder/created/list-all")
      return json({
        code: 0,
        data: state.folders.length ? { count: state.folders.length, list: state.folders } : null,
      })
    if (url.pathname === "/x/v3/fav/resource/list") {
      const medias = [...(state.medias.get(Number(url.searchParams.get("media_id"))) ?? [])].sort(
        (left, right) => right.fav_time - left.fav_time,
      )
      return json({
        code: 0,
        data: {
          has_more: medias.length > page * size,
          medias: medias.slice((page - 1) * size, page * size).map((media) => ({
            type: 2,
            intro: `About ${media.title}`,
            cover: `http://i0.hdslb.com/${media.bvid}.jpg`,
            duration: 125,
            pubtime: media.fav_time - 86_400,
            upper: { mid: 42, name: "Uploader" },
            cnt_info: { play: 10, collect: 2, danmaku: 1 },
            ...media,
          })),
        },
      })
    }
    return new Response("not found", { status: 404 })
  })
  return { state, calls, fetchImplementation }
}

const adapterFor = (fetchImplementation: typeof fetch) =>
  new BilibiliBehaviorAdapter({
    client: new SafeHTTPClient({
      fetchImplementation,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      maxBytes: 1024 * 1024,
      timeoutMs: 1000,
    }),
    requestDelayMs: 0,
    wait: async () => undefined,
  })

const setup = async (
  scope: "favorites" | "follows",
  options: { credential?: boolean; checkBudgetMs?: number } = {},
) => {
  const bilibili = fakeBilibili()
  const repository = new MemorySupplierRepository(Buffer.alloc(32, 7))
  const service = new PlatformBehaviorService(repository, {
    adapters: [adapterFor(bilibili.fetchImplementation)],
    resolveCredential: async () => SESSDATA,
    checkBudgetMs: options.checkBudgetMs,
  })
  let credentialId: string | null = null
  if (options.credential ?? true) {
    credentialId = "11111111-1111-4111-8111-111111111111"
    await repository.createCredential(
      {
        id: credentialId,
        name: "Bilibili login",
        description: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        disabledAt: null,
        authenticationTag: Buffer.alloc(16),
        ciphertext: Buffer.alloc(1),
        initializationVector: Buffer.alloc(12),
        keyId: "test",
      },
      {
        action: "credential.created",
        actor: "test",
        details: {},
        id: "22222222-2222-4222-8222-222222222222",
        occurredAt: "2026-10-01T00:00:00.000Z",
        resourceId: credentialId,
        resourceType: "credential",
      },
    )
  }
  const source = await service.createSource(
    {
      name: `B 站 ${scope}`,
      platform: "bilibili",
      scope,
      accountId: ACCOUNT,
      credentialId,
      enabled: true,
      intervalMinutes: 360,
    },
    "test",
  )
  return { ...bilibili, repository, service, source }
}

describe("Bilibili behavior adapter", () => {
  it("sends a bare credential as SESSDATA and refuses multi-line cookies", () => {
    expect(bilibiliCookieHeader(" abc ")).toBe("SESSDATA=abc")
    expect(bilibiliCookieHeader("SESSDATA=abc; bili_jct=x")).toBe("SESSDATA=abc; bili_jct=x")
    expect(() => bilibiliCookieHeader("abc\r\nX-Injected: 1")).toThrow(PlatformBehaviorError)
  })
})

describe("platform behavior sources", () => {
  it("records a baseline first, then publishes all new follows of a check as one entry", async () => {
    const { state, calls, service, source, repository } = await setup("follows")
    state.follows = [
      { mid: 1, uname: "Old A", mtime: seconds("2026-09-01T00:00:00Z") },
      { mid: 2, uname: "Old B", mtime: seconds("2026-09-02T00:00:00Z") },
    ]
    const baseline = await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    expect(baseline).toMatchObject({ status: "baseline_recorded", publishedCount: 0 })
    expect(baseline!.source.baselineAt).toBe("2026-10-01T00:00:00.000Z")
    expect(calls[0]).toMatchObject({ cookie: `SESSDATA=${SESSDATA}` })

    state.follows.push(
      { mid: 3, uname: "New C", mtime: seconds("2026-10-01T03:00:00Z"), sign: "<b>bio</b>" },
      { mid: 4, uname: "New D", mtime: seconds("2026-10-01T05:00:00Z") },
      // Older than the baseline but never seen, as when an unfollow pulls it onto the page.
      { mid: 5, uname: "Old E", mtime: seconds("2026-08-01T00:00:00Z") },
    )
    const checked = await service.checkSource(source.id, new Date("2026-10-01T06:00:00Z"))
    expect(checked).toMatchObject({
      status: "entries_published",
      publishedCount: 1,
      newObjectCount: 3,
    })
    const [entry] = (await service.listEntries(source.id, 10))!
    expect(entry).toMatchObject({
      title: "新关注 2 位 UP 主：New D、New C",
      url: `https://space.bilibili.com/${ACCOUNT}/relation/follow`,
      occurredAt: "2026-10-01T05:00:00.000Z",
      summary: "新关注：New D、New C",
    })
    expect(entry!.content).toContain('<a href="https://space.bilibili.com/3">New C</a>')
    expect(entry!.content).toContain("&lt;b&gt;bio&lt;/b&gt;")
    expect(entry!.content).toContain("关注时间：2026-10-01 11:00")
    expect(entry!.content).not.toContain("Old E")
    expect(await repository.findBehaviorObjectKeys(source.id, ["5"])).toEqual(["5"])

    const again = await service.checkSource(source.id, new Date("2026-10-01T12:00:00Z"))
    expect(again).toMatchObject({ status: "unchanged", publishedCount: 0, newObjectCount: 0 })
  })

  it("reads further follow pages only when a whole page is new", async () => {
    const { state, calls, service, source } = await setup("follows")
    state.follows = Array.from({ length: 120 }, (_value, index) => ({
      mid: 1000 + index,
      uname: `Old ${index}`,
      mtime: seconds("2026-09-01T00:00:00Z") - index,
    }))
    await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    // The baseline only needs the newest page.
    expect(calls.map((call) => call.page)).toEqual(["1"])

    for (let index = 0; index < 60; index++)
      state.follows.push({
        mid: 5000 + index,
        uname: `New ${index}`,
        mtime: seconds("2026-10-01T02:00:00Z") + index,
      })
    calls.length = 0
    const checked = await service.checkSource(source.id, new Date("2026-10-01T06:00:00Z"))
    expect(calls.map((call) => call.page)).toEqual(["1", "2"])
    expect(checked).toMatchObject({ publishedCount: 1, newObjectCount: 60 })
    const [entry] = (await service.listEntries(source.id, 1))!
    expect(entry!.title.startsWith("新关注 60 位 UP 主：New 59、New 58")).toBe(true)
    // The title is bounded; the body still lists every account.
    expect([...entry!.title].length).toBeLessThanOrEqual(300)
    expect(entry!.content.match(/<li>/g)).toHaveLength(60)
  })

  it("publishes each new favorite once, across folders, with its facts", async () => {
    const { state, service, source } = await setup("favorites")
    state.folders = [
      { id: 10, title: "默认收藏夹", media_count: 2 },
      { id: 11, title: "学习", media_count: 1 },
      { id: 12, title: "空", media_count: 0 },
    ]
    state.medias.set(10, [
      { bvid: "BV1old", title: "Old video", fav_time: seconds("2026-09-01T00:00:00Z") },
    ])
    await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))

    state.medias
      .get(10)!
      .push(
        { bvid: "BV1new", title: "New video", fav_time: seconds("2026-10-02T00:00:00Z") },
        { bvid: "BV1gone", title: "已失效视频", fav_time: seconds("2026-10-02T01:00:00Z") },
        { bvid: "BV1audio", title: "A song", fav_time: seconds("2026-10-02T02:00:00Z"), type: 12 },
      )
    state.medias.set(11, [
      { bvid: "BV1new", title: "New video", fav_time: seconds("2026-10-02T04:00:00Z") },
      { bvid: "BV1two", title: "Second", fav_time: seconds("2026-10-02T03:00:00Z") },
    ])
    const checked = await service.checkSource(source.id, new Date("2026-10-03T00:00:00Z"))
    expect(checked).toMatchObject({ status: "entries_published", publishedCount: 2 })
    expect(checked!.notes).toEqual(["2 unavailable or non-video items were skipped"])
    const entries = (await service.listEntries(source.id, 10))!
    expect(entries.map((entry) => entry.title)).toEqual(["New video", "Second"])
    expect(entries[0]).toMatchObject({
      url: "https://www.bilibili.com/video/BV1new",
      imageURL: "https://i0.hdslb.com/BV1new.jpg",
      occurredAt: "2026-10-02T04:00:00.000Z",
      summary: "UP 主：Uploader｜收藏夹：默认收藏夹、学习｜About New video",
    })
    expect(entries[0]!.content).toContain("收藏夹：默认收藏夹、学习")
    expect(entries[0]!.content).toContain("时长：2:05")
    expect(entries[0]!.content).toContain("播放 10 · 收藏 2 · 弹幕 1")

    const feed = await service.materializeFeed(source.feedURL)
    expect(feed.upstreamURL).toBe(`https://space.bilibili.com/${ACCOUNT}/favlist`)
    expect(feed.body).toContain("<title>New video</title>")
    expect(feed.body).toContain(
      '<enclosure url="https://i0.hdslb.com/BV1new.jpg" type="image/jpeg" length="0"/>',
    )
  })

  it("keeps favorites from folders it ran out of time for quiet when they turn up later", async () => {
    const { state, service, source, repository } = await setup("favorites", { checkBudgetMs: 0 })
    state.folders = [{ id: 10, title: "默认收藏夹", media_count: 1 }]
    state.medias.set(10, [
      { bvid: "BV1old", title: "Old", fav_time: seconds("2026-09-01T00:00:00Z") },
    ])
    const baseline = await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    expect(baseline!.notes).toEqual(["1 folders were left for the next check"])

    // The next check has time for the folder; its old favorite is recorded, not published.
    const bilibili = fakeBilibili()
    bilibili.state.folders = state.folders
    bilibili.state.medias = state.medias
    const later = new PlatformBehaviorService(repository, {
      adapters: [adapterFor(bilibili.fetchImplementation)],
      resolveCredential: async () => SESSDATA,
    })
    const checked = await later.checkSource(source.id, new Date("2026-10-01T06:00:00Z"))
    expect(checked).toMatchObject({ status: "unchanged", newObjectCount: 1, publishedCount: 0 })
  })

  it("refuses an anonymous favorites baseline that sees no folders", async () => {
    const { service, source } = await setup("favorites", { credential: false })
    await expect(
      service.checkSource(source.id, new Date("2026-10-01T00:00:00Z")),
    ).rejects.toMatchObject({ code: "behavior_access_denied" })
    const failed = (await service.getSource(source.id))!
    expect(failed).toMatchObject({ baselineAt: null, consecutiveFailures: 1 })
  })

  it("reports an expired login without repeating it and waits before trying again", async () => {
    const { state, service, source } = await setup("follows")
    state.code = -101
    const error = await service
      .checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "behavior_auth_invalid", statusCode: 503 })
    const failed = (await service.getSource(source.id))!
    expect(failed.lastErrorCode).toBe("behavior_auth_invalid")
    expect(JSON.stringify([error, failed])).not.toContain(SESSDATA)
    expect(Date.parse(failed.nextCheckAt!) - Date.parse("2026-10-01T00:00:00Z")).toBe(
      6 * 60 * 60_000,
    )

    state.code = -412
    await expect(
      service.checkSource(source.id, new Date("2026-10-01T06:00:00Z")),
    ).rejects.toMatchObject({ code: "behavior_rate_limited", statusCode: 429 })
  })

  it("validates the account, scope and credential when a source is created", async () => {
    const { service } = await setup("follows")
    const input = {
      name: "Another",
      platform: "bilibili" as const,
      scope: "follows" as const,
      accountId: "not-a-uid",
      credentialId: null,
      enabled: false,
      intervalMinutes: 360,
    }
    await expect(service.createSource(input, "test")).rejects.toMatchObject({
      code: "behavior_account_invalid",
    })
    await expect(
      service.createSource(
        { ...input, accountId: ACCOUNT, credentialId: "33333333-3333-4333-8333-333333333333" },
        "test",
      ),
    ).rejects.toMatchObject({ code: "behavior_credential_unavailable" })
  })
})

const config = loadFeedSupplierConfig({
  INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
  NODE_ENV: "test",
  PUBLIC_FEED_BASE_URL: "https://feeds.example.com",
  RSSHUB_ACCESS_KEY: "rsshub-access-key-11111111111111111111",
  RSSHUB_BASE_URL: "http://rsshub:1200",
})
const databaseURL = process.env.TEST_FEED_SUPPLIER_DATABASE_URL
  ? await isolatedDatabaseURL(process.env.TEST_FEED_SUPPLIER_DATABASE_URL, "behavior")
  : undefined
const repositories: Array<[string, () => SupplierRepository | undefined]> = [
  ["memory", () => undefined],
  ...(databaseURL
    ? [
        [
          "postgres",
          () =>
            new PostgresSupplierRepository({
              auditKey: config.auditHmacKey,
              connectionString: databaseURL,
              maxConnections: 2,
            }),
        ] as [string, () => SupplierRepository | undefined],
      ]
    : []),
]

describe.each(repositories)("behavior source routes (%s)", (_name, create) => {
  it("creates, checks and serves a behavior feed through the admin and feed routes", async () => {
    const bilibili = fakeBilibili()
    const server = await buildFeedSupplier({
      behaviorAdapters: [adapterFor(bilibili.fetchImplementation)],
      config,
      fetchImplementation: vi.fn<typeof fetch>(),
      repository: create(),
    })
    const suffix = crypto.randomUUID().slice(0, 8)
    const request = async <T>(method: "GET" | "PATCH" | "POST", url: string, body?: object) => {
      const response = await server.inject({
        headers: { authorization: `Bearer ${config.adminToken}` },
        method,
        url,
        ...(body ? { payload: body } : {}),
      })
      return { status: response.statusCode, body: response.json<T>() }
    }
    const credential = (
      await request<{ credential: { id: string } }>("POST", "/v1/admin/credentials", {
        name: `bilibili-${suffix}`,
        value: SESSDATA,
      })
    ).body.credential
    const created = await request<{ source: PlatformBehaviorSource }>(
      "POST",
      "/v1/admin/behavior-sources",
      {
        name: `B 站新关注 ${suffix}`,
        platform: "bilibili",
        scope: "follows",
        accountId: ACCOUNT,
        credentialId: credential.id,
      },
    )
    expect(created.status).toBe(201)
    // Sources start unscheduled with a six-hour interval ready to enable.
    expect(created.body.source).toMatchObject({
      enabled: false,
      intervalMinutes: 360,
      nextCheckAt: null,
    })
    const base = `/v1/admin/behavior-sources/${created.body.source.id}`
    expect(
      (await request("PATCH", base, { accountId: "87654321" })).status,
      "the watched account is fixed",
    ).toBe(400)

    bilibili.state.follows = [{ mid: 1, uname: "Old", mtime: seconds("2026-09-01T00:00:00Z") }]
    const tested = await request<{ objectCount: number; requestCount: number }>(
      "POST",
      `${base}/test`,
    )
    expect(tested.body).toMatchObject({ objectCount: 1, requestCount: 1 })
    expect(bilibili.calls[0]!.cookie).toBe(`SESSDATA=${SESSDATA}`)
    expect((await request<PlatformBehaviorCheckResult>("POST", `${base}/check`)).body.status).toBe(
      "baseline_recorded",
    )
    bilibili.state.follows.push({ mid: 2, uname: "Fresh", mtime: Date.now() / 1000 + 60 })
    expect(
      (await request<PlatformBehaviorCheckResult>("POST", `${base}/check`)).body,
    ).toMatchObject({ status: "entries_published", publishedCount: 1 })
    const entries = await request<{ entries: PlatformBehaviorEntry[] }>("GET", `${base}/entries`)
    expect(entries.body.entries.map((entry) => entry.title)).toEqual(["新关注 UP 主：Fresh"])

    const feedRequest = {
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "GET" as const,
      url: `/v1/feeds/behavior?url=${encodeURIComponent(created.body.source.feedURL)}`,
    }
    const feed = await server.inject(feedRequest)
    expect(feed.statusCode).toBe(200)
    expect(feed.body).toContain("新关注 UP 主：Fresh")
    expect(feed.body).not.toContain(SESSDATA)
    expect(
      (
        await server.inject({
          ...feedRequest,
          headers: { ...feedRequest.headers, "if-none-match": feed.headers.etag as string },
        })
      ).statusCode,
    ).toBe(304)

    // A public link can be issued for it, and the credential report names the login it uses.
    const grant = (
      await request<{ grant: { id: string } }>("POST", "/v1/admin/public-feed-grants", {
        name: `reader-${suffix}`,
      })
    ).body.grant
    expect(
      (
        await request("POST", `/v1/admin/public-feed-grants/${grant.id}/links`, {
          sourceURL: created.body.source.feedURL,
        })
      ).status,
    ).toBe(201)
    const usage = await request<{
      links: { sourceURL: string; dependency: { boundCredentials: string[] } }[]
    }>("GET", "/v1/admin/credential-usage")
    expect(
      usage.body.links.find((link) => link.sourceURL === created.body.source.feedURL)?.dependency,
    ).toMatchObject({ status: "uses", boundCredentials: [`bilibili-${suffix}`] })
    await server.close()
  })
})
