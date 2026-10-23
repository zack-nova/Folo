import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import { MemorySupplierRepository } from "../src/memory-repository"
import { PlatformBehaviorService } from "../src/platform-behavior-service"
import { DouyinBehaviorAdapter } from "../src/platforms/douyin"
import { buildFeedSupplier } from "../src/server"

const ACCOUNT = "MS4wLjABAAAAexample-sec-uid-of-the-owner"
const LOGIN = "sessionid=personal-session; ttwid=personal-ttwid; UIFID=personal-uifid"
const READER_TOKEN = "douyin-reader-token-000000000000000"

interface FakeVideo {
  awemeId: string
  description: string
  awemeType?: number
}
/** A stand-in for the douyin-reader sidecar, paging newest first like Douyin. */
const fakeReader = () => {
  const state = {
    follows: [] as { secUid: string; nickname: string; signature?: string }[],
    favorites: [] as FakeVideo[],
    /** Answer with this status (and code) from the given request number on */
    failFrom: Infinity,
    failure: { status: 429, code: "douyin_rejected" },
  }
  const calls: { path: string; cursor: string | null; body: Record<string, unknown> }[] = []
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${READER_TOKEN}`)
    calls.push({ path: url.pathname, cursor: body.cursor as string | null, body })
    if (calls.length >= state.failFrom)
      return Response.json(
        { code: state.failure.code, message: "refused" },
        { status: state.failure.status },
      )
    const list = url.pathname === "/v1/follows" ? state.follows : state.favorites
    const offset = Number(body.cursor ?? 0)
    const count = Number(body.count)
    const items = list.slice(offset, offset + count).map((item) =>
      "secUid" in item
        ? { avatar: "", uniqueId: "", followerCount: 3, awemeCount: 1, verification: "", ...item }
        : {
            awemeType: 0,
            createTime: Date.parse("2026-09-01T00:00:00Z") / 1000,
            authorName: "Maker",
            authorSecUid: "MS4wLjABAAAAmaker",
            cover: "https://p3.douyinpic.com/cover.jpeg",
            durationMs: 65_000,
            likes: 10,
            comments: 2,
            collects: 4,
            shares: 1,
            ...item,
          },
    )
    const hasMore = offset + count < list.length
    return Response.json({ items, hasMore, cursor: hasMore ? String(offset + count) : null })
  })
  return { state, calls, fetchImplementation }
}

const setup = async (
  scope: "favorites" | "follows",
  options: { checkBudgetMs?: number; credential?: string | null } = {},
) => {
  const reader = fakeReader()
  const repository = new MemorySupplierRepository(Buffer.alloc(32, 7))
  const adapter = new DouyinBehaviorAdapter({
    readerURL: "http://douyin-reader:3011",
    readerToken: READER_TOKEN,
    requestDelayMs: 0,
    timeoutMs: 1000,
    fetchImplementation: reader.fetchImplementation,
    wait: async () => undefined,
  })
  const credential = options.credential === undefined ? LOGIN : options.credential
  const service = new PlatformBehaviorService(repository, {
    adapters: [adapter],
    resolveCredential: async () => credential ?? "",
    checkBudgetMs: options.checkBudgetMs,
  })
  const source = await service.createSource(
    {
      name: `抖音 ${scope}`,
      platform: "douyin",
      scope,
      accountId: ACCOUNT,
      credentialId: null,
      enabled: true,
      intervalMinutes: 360,
    },
    "test",
  )
  if (credential !== null)
    await repository.updateBehaviorSource(
      { ...source, credentialId: "11111111-1111-4111-8111-111111111111" },
      {
        action: "behavior_source.updated",
        actor: "test",
        details: {},
        id: "22222222-2222-4222-8222-222222222222",
        occurredAt: "2026-10-01T00:00:00.000Z",
        resourceId: source.id,
        resourceType: "behavior_source",
      },
    )
  return { ...reader, service, source }
}
const accounts = (count: number, prefix: string) =>
  Array.from({ length: count }, (_value, index) => ({
    secUid: `MS4wLjABAAAA${prefix}-${index}`,
    nickname: `${prefix} ${index}`,
  }))

describe("Douyin behavior sources", () => {
  it("reads the whole follow list as the baseline across checks", async () => {
    const { state, calls, service, source } = await setup("follows", { checkBudgetMs: 0 })
    state.follows = accounts(45, "old")
    const first = await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    expect(first).toMatchObject({ status: "baseline_in_progress", newObjectCount: 20 })
    expect(first!.source.baselineCursor).toBe("20")
    expect(calls[0]!.body).toEqual({ cookie: LOGIN, accountId: ACCOUNT, cursor: null, count: 20 })
    await service.checkSource(source.id, new Date("2026-10-01T00:15:00Z"))
    const third = await service.checkSource(source.id, new Date("2026-10-01T00:30:00Z"))
    expect(third).toMatchObject({ status: "baseline_recorded", newObjectCount: 5 })
    expect(calls.map((call) => call.cursor)).toEqual([null, "20", "40"])
  })

  it("publishes new follows at their discovery time and stops at known accounts", async () => {
    const { state, calls, service, source } = await setup("follows")
    state.follows = accounts(30, "old")
    await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    state.follows.unshift({
      secUid: "MS4wLjABAAAAnew",
      nickname: "New",
      signature: "Line 1\nLine 2",
    })
    calls.length = 0
    const checked = await service.checkSource(source.id, new Date("2026-10-01T06:00:00Z"))
    expect(calls.map((call) => call.cursor)).toEqual([null])
    expect(checked).toMatchObject({ status: "entries_published", publishedCount: 1 })
    const [entry] = (await service.listEntries(source.id, 1))!
    expect(entry).toMatchObject({
      title: "新关注抖音用户：New",
      url: "https://www.douyin.com/user/MS4wLjABAAAAnew",
      occurredAt: "2026-10-01T06:00:00.000Z",
    })
    expect(entry!.content).toContain("Line 1<br>Line 2")
    expect(entry!.content).toContain("3 粉丝 · 1 作品")
  })

  it("publishes each new favorite with its facts, image posts under /note/", async () => {
    const { state, service, source } = await setup("favorites")
    state.favorites = [{ awemeId: "7400000000000000001", description: "Old" }]
    await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    state.favorites.unshift(
      { awemeId: "7400000000000000003", description: "A note\nsecond line", awemeType: 68 },
      { awemeId: "7400000000000000002", description: "" },
    )
    const checked = await service.checkSource(source.id, new Date("2026-10-01T06:00:00Z"))
    expect(checked).toMatchObject({ status: "entries_published", publishedCount: 2 })
    const entries = (await service.listEntries(source.id, 5))!
    const note = entries.find((entry) => entry.url.includes("/note/"))
    expect(note).toMatchObject({
      title: "A note",
      url: "https://www.douyin.com/note/7400000000000000003",
      imageURL: "https://p3.douyinpic.com/cover.jpeg",
      summary: "作者：Maker｜A note\nsecond line",
    })
    expect(note!.content).toContain("时长：1:05")
    expect(note!.content).toContain("点赞 10 · 评论 2 · 收藏 4 · 分享 1")
    expect(entries.find((entry) => entry.url.includes("/video/"))!.title).toBe(
      "抖音作品 7400000000000000002",
    )
  })

  it("keeps baseline progress when Douyin refuses and resumes an hour later", async () => {
    const { state, service, source } = await setup("favorites")
    state.favorites = Array.from({ length: 50 }, (_value, index) => ({
      awemeId: `74000000000000${String(index).padStart(5, "0")}`,
      description: `Video ${index}`,
    }))
    state.failFrom = 3
    const first = await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    expect(first).toMatchObject({ status: "baseline_in_progress", newObjectCount: 40 })
    expect(first!.source).toMatchObject({
      baselineCursor: "40",
      nextCheckAt: "2026-10-01T01:00:00.000Z",
    })
    expect(first!.notes).toEqual([
      "Douyin restricted the request after 40 favorites; the baseline continues later",
    ])
  })

  it("reports logins, other accounts and an unreachable reader without the cookie", async () => {
    const { state, service, source } = await setup("follows")
    state.failFrom = 1
    state.failure = { status: 401, code: "douyin_auth_invalid" }
    await expect(
      service.checkSource(source.id, new Date("2026-10-01T00:00:00Z")),
    ).rejects.toMatchObject({ code: "behavior_auth_invalid", statusCode: 503 })
    state.failure = { status: 403, code: "douyin_account_mismatch" }
    const mismatch = await service
      .checkSource(source.id, new Date("2026-10-02T00:00:00Z"))
      .catch((caught: unknown) => caught)
    expect(mismatch).toMatchObject({ code: "behavior_account_mismatch" })
    expect(JSON.stringify([mismatch, await service.getSource(source.id)])).not.toContain(
      "personal-session",
    )

    const unreachable = await setup("follows")
    unreachable.fetchImplementation.mockRejectedValue(new TypeError("fetch failed"))
    await expect(
      unreachable.service.checkSource(unreachable.source.id, new Date("2026-10-01T00:00:00Z")),
    ).rejects.toMatchObject({ code: "behavior_request_failed", statusCode: 503 })
  })

  it("needs a bound login", async () => {
    const { calls, service, source } = await setup("follows", { credential: null })
    await expect(
      service.checkSource(source.id, new Date("2026-10-01T00:00:00Z")),
    ).rejects.toMatchObject({ code: "behavior_auth_invalid" })
    expect(calls).toHaveLength(0)
  })
})

describe("Douyin reader configuration", () => {
  const base = {
    INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
    NODE_ENV: "test",
    RSSHUB_ACCESS_KEY: "rsshub-access-key-11111111111111111111",
    RSSHUB_BASE_URL: "http://rsshub:1200",
  }

  it("needs the reader URL and token together", () => {
    expect(() =>
      loadFeedSupplierConfig({ ...base, DOUYIN_READER_URL: "http://douyin-reader:3011" }),
    ).toThrow("set together")
    expect(
      loadFeedSupplierConfig({
        ...base,
        DOUYIN_READER_URL: "http://douyin-reader:3011",
        DOUYIN_READER_TOKEN: READER_TOKEN,
      }).douyinReader,
    ).toEqual({ url: "http://douyin-reader:3011", token: READER_TOKEN })
  })

  it("offers Douyin sources only where a reader is configured", async () => {
    const server = await buildFeedSupplier({ config: loadFeedSupplierConfig(base) })
    const response = await server.inject({
      method: "POST",
      url: "/v1/admin/behavior-sources",
      headers: { authorization: `Bearer ${loadFeedSupplierConfig(base).adminToken}` },
      payload: { name: "抖音", platform: "douyin", scope: "follows", accountId: ACCOUNT },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: "behavior_platform_unsupported" })
    await server.close()
  })
})
