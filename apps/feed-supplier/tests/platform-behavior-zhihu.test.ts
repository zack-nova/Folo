import { describe, expect, it, vi } from "vitest"

import { MemorySupplierRepository } from "../src/memory-repository"
import { PlatformBehaviorService } from "../src/platform-behavior-service"
import { ZhihuBehaviorAdapter, zhihuCookieHeader } from "../src/platforms/zhihu"
import { SafeHTTPClient } from "../src/safe-http"

const ACCOUNT = "example-token"
const LOGIN = "personal-z_c0-value"
const seconds = (iso: string) => Date.parse(iso) / 1000

interface FakeContent {
  id: number | string
  type: string
  title: string
  collect_time: number
  is_deleted?: boolean
}
/** A small stand-in for the Zhihu endpoints the adapter reads. */
const fakeZhihu = () => {
  const state = {
    status: 200,
    /** Answer 403 once this many requests were served, as Zhihu does to fast paging */
    restrictAfter: Infinity,
    /** Request numbers answered with a single 403, as Zhihu now and then does */
    refuseOnce: new Set<number>(),
    followees: [] as { id: string; url_token: string; name: string; headline?: string }[],
    folders: [] as { id: number; title: string; updated_time: number }[],
    contents: new Map<number, FakeContent[]>(),
  }
  const calls: { path: string; offset: string | null; cookie: string | null }[] = []
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    calls.push({
      path: url.pathname,
      offset: url.searchParams.get("offset"),
      cookie: new Headers(init?.headers).get("cookie"),
    })
    if (state.refuseOnce.has(calls.length)) return new Response('{"error":{}}', { status: 403 })
    if (state.status !== 200 || calls.length > state.restrictAfter)
      return new Response('{"error":{}}', {
        status: calls.length > state.restrictAfter ? 403 : state.status,
      })
    const offset = Number(url.searchParams.get("offset") ?? 0)
    const limit = Number(url.searchParams.get("limit") ?? 20)
    const page = <T>(items: T[]) =>
      json({
        data: items.slice(offset, offset + limit),
        paging: { is_end: offset + limit >= items.length, totals: items.length },
      })
    if (url.pathname === `/api/v4/members/${ACCOUNT}/followees`) return page(state.followees)
    if (url.pathname === `/api/v4/members/${ACCOUNT}/favlists`) return page(state.folders)
    const folder = /^\/api\/v4\/collections\/(\d+)\/contents$/.exec(url.pathname)
    if (folder) {
      const contents = [...(state.contents.get(Number(folder[1])) ?? [])]
        .sort((left, right) => right.collect_time - left.collect_time)
        .map((content) =>
          // Posts (想法) come as text blocks with an excerpt title, as the live API sends them.
          content.type === "pin"
            ? {
                ...content,
                title: undefined,
                excerpt_title: content.title,
                content: [{ type: "text", content: `<p>${content.title} in full</p>` }],
                author: { name: "Poster", url_token: "poster" },
              }
            : {
                ...content,
                excerpt: `<p>About <b>${content.title}</b></p>`,
                author: { name: "Writer", url_token: "writer", headline: "Explains things" },
                question:
                  content.type === "answer"
                    ? { id: "2093281358667956789", title: content.title }
                    : undefined,
                voteup_count: 12,
                comment_count: 3,
              },
        )
      // The live API writes 19-digit IDs as bare JSON numbers.
      return new Response(
        JSON.stringify({
          data: contents.slice(offset, offset + limit),
          paging: { is_end: offset + limit >= contents.length },
        }).replace(/"id":"(\d{17,})"/g, '"id":$1'),
        { headers: { "content-type": "application/json" } },
      )
    }
    return new Response("not found", { status: 404 })
  })
  return { state, calls, fetchImplementation }
}

const setup = async (scope: "favorites" | "follows", checkBudgetMs?: number) => {
  const zhihu = fakeZhihu()
  const repository = new MemorySupplierRepository(Buffer.alloc(32, 7))
  const adapter = new ZhihuBehaviorAdapter({
    client: new SafeHTTPClient({
      fetchImplementation: zhihu.fetchImplementation,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      maxBytes: 1024 * 1024,
      timeoutMs: 1000,
    }),
    requestDelayMs: 0,
    wait: async () => undefined,
  })
  const service = new PlatformBehaviorService(repository, {
    adapters: [adapter],
    resolveCredential: async () => LOGIN,
    checkBudgetMs,
  })
  const source = await service.createSource(
    {
      name: `知乎 ${scope}`,
      platform: "zhihu",
      scope,
      accountId: ACCOUNT,
      credentialId: null,
      enabled: true,
      intervalMinutes: 360,
    },
    "test",
  )
  // Sources with a credential pass it to the adapter; here the service resolves a fixed one.
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
  return { ...zhihu, repository, service, source }
}
const users = (count: number, prefix: string) =>
  Array.from({ length: count }, (_value, index) => ({
    id: `${prefix}-${index}`,
    url_token: `${prefix}-token-${index}`,
    name: `${prefix} ${index}`,
  }))

describe("Zhihu behavior adapter", () => {
  it("sends a bare credential as z_c0", () => {
    expect(zhihuCookieHeader("abc")).toBe("z_c0=abc")
    expect(zhihuCookieHeader("z_c0=abc; d_c0=def")).toBe("z_c0=abc; d_c0=def")
  })
})

describe("Zhihu behavior sources", () => {
  it("reads the whole follow list as the baseline, across checks, before publishing", async () => {
    const { state, calls, service, source } = await setup("follows", 0)
    state.followees = users(50, "old")
    const first = await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    expect(first).toMatchObject({ status: "baseline_in_progress", publishedCount: 0 })
    expect(first!.source).toMatchObject({ baselineAt: null, baselineCursor: "20" })
    expect(first!.notes).toEqual(["The baseline read 20 follows and continues in the next check"])
    // An unfinished baseline continues a quarter of an hour later, not after six hours.
    expect(first!.source.nextCheckAt).toBe("2026-10-01T00:15:00.000Z")
    expect(calls[0]!.cookie).toBe(`z_c0=${LOGIN}`)

    const second = await service.checkSource(source.id, new Date("2026-10-01T00:15:00Z"))
    expect(second).toMatchObject({ status: "baseline_in_progress", newObjectCount: 20 })
    const third = await service.checkSource(source.id, new Date("2026-10-01T00:30:00Z"))
    expect(third).toMatchObject({ status: "baseline_recorded", newObjectCount: 10 })
    expect(third!.source).toMatchObject({
      baselineAt: "2026-10-01T00:30:00.000Z",
      baselineCursor: null,
      nextCheckAt: "2026-10-01T06:30:00.000Z",
    })
    expect(calls.map((call) => call.offset)).toEqual(["0", "20", "40"])
  })

  it("publishes new follows at their discovery time and stops paging at known accounts", async () => {
    const { state, calls, service, source } = await setup("follows")
    state.followees = users(45, "old")
    await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    expect(calls).toHaveLength(3)

    state.followees.unshift(
      { id: "new-1", url_token: "new-one", name: "New One", headline: "<em>Writes</em>" },
      { id: "new-2", url_token: "new-two", name: "New Two" },
    )
    // An unfollow lets an account seen in the baseline move up; it is not new.
    state.followees.splice(5, 1)
    calls.length = 0
    const checked = await service.checkSource(source.id, new Date("2026-10-01T06:00:00Z"))
    expect(calls.map((call) => call.offset)).toEqual(["0"])
    expect(checked).toMatchObject({ status: "entries_published", publishedCount: 1 })
    const [entry] = (await service.listEntries(source.id, 1))!
    expect(entry).toMatchObject({
      title: "新关注 2 位知乎用户：New One、New Two",
      url: `https://www.zhihu.com/people/${ACCOUNT}/following`,
      occurredAt: "2026-10-01T06:00:00.000Z",
    })
    expect(entry!.content).toContain('<a href="https://www.zhihu.com/people/new-one">New One</a>')
    expect(entry!.content).toContain("<br>Writes")
    expect(entry!.content).toContain("这里的时间是发现时间")

    const again = await service.checkSource(source.id, new Date("2026-10-01T12:00:00Z"))
    expect(again).toMatchObject({ status: "unchanged", newObjectCount: 0 })
  })

  it("keeps baseline progress when Zhihu pushes back and resumes an hour later", async () => {
    const { state, calls, service, source } = await setup("follows")
    state.followees = users(50, "old")
    state.restrictAfter = 2
    const first = await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    expect(first).toMatchObject({ status: "baseline_in_progress", newObjectCount: 40 })
    expect(first!.source).toMatchObject({
      baselineCursor: "40",
      consecutiveFailures: 0,
      nextCheckAt: "2026-10-01T01:00:00.000Z",
    })
    expect(first!.notes).toEqual([
      "Zhihu restricted the request after 40 follows; the baseline continues later",
    ])
    state.restrictAfter = Infinity
    const second = await service.checkSource(source.id, new Date("2026-10-01T01:00:00Z"))
    expect(second).toMatchObject({ status: "baseline_recorded", newObjectCount: 10 })
    // The refused page was tried three times before the check gave up on it.
    expect(calls.map((call) => call.offset)).toEqual(["0", "20", "40", "40", "40", "40"])

    // A refusal on the very first page is a failure that waits hours, not a partial read.
    state.restrictAfter = calls.length
    await expect(
      service.checkSource(source.id, new Date("2026-10-01T07:00:00Z")),
    ).rejects.toMatchObject({ code: "behavior_rate_limited" })
  })

  it("retries a page Zhihu refuses once", async () => {
    const { state, calls, service, source } = await setup("follows")
    state.followees = users(50, "old")
    state.refuseOnce = new Set([2])
    const checked = await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    expect(checked).toMatchObject({ status: "baseline_recorded", newObjectCount: 50 })
    expect(calls.map((call) => call.offset)).toEqual(["0", "20", "20", "40"])
  })

  it("previews only the first page of a long follow list", async () => {
    const { state, calls, service, source } = await setup("follows")
    state.followees = users(45, "old")
    expect(await service.testSource(source.id, "test")).toMatchObject({
      objectCount: 20,
      requestCount: 1,
    })
    expect(calls).toHaveLength(1)
  })

  it("reads only changed folders and publishes each new favorite once", async () => {
    const { state, calls, service, source } = await setup("favorites")
    state.folders = [
      { id: 1, title: "读书", updated_time: seconds("2026-09-01T00:00:00Z") },
      { id: 2, title: "工作", updated_time: seconds("2026-09-02T00:00:00Z") },
    ]
    state.contents.set(1, [
      {
        id: 10,
        type: "answer",
        title: "Old answer",
        collect_time: seconds("2026-09-01T00:00:00Z"),
      },
    ])
    state.contents.set(2, [
      {
        id: 20,
        type: "article",
        title: "Old article",
        collect_time: seconds("2026-09-02T00:00:00Z"),
      },
    ])
    await service.checkSource(source.id, new Date("2026-10-01T00:00:00Z"))
    expect(calls.map((call) => call.path)).toEqual([
      `/api/v4/members/${ACCOUNT}/favlists`,
      "/api/v4/collections/1/contents",
      "/api/v4/collections/2/contents",
    ])

    state.folders[0]!.updated_time = seconds("2026-10-01T05:00:00Z")
    state.contents.get(1)!.push(
      {
        id: "2096922844882015123",
        type: "answer",
        title: "New answer",
        collect_time: seconds("2026-10-01T05:00:00Z"),
      },
      { id: 13, type: "pin", title: "A short post", collect_time: seconds("2026-10-01T04:30:00Z") },
      {
        id: 20,
        type: "article",
        title: "Old article",
        collect_time: seconds("2026-10-01T04:00:00Z"),
      },
      {
        id: 12,
        type: "answer",
        title: "Removed",
        collect_time: seconds("2026-10-01T03:00:00Z"),
        is_deleted: true,
      },
    )
    calls.length = 0
    const checked = await service.checkSource(source.id, new Date("2026-10-01T06:00:00Z"))
    // Folder 2 did not change, so it is not read.
    expect(calls.map((call) => call.path)).toEqual([
      `/api/v4/members/${ACCOUNT}/favlists`,
      "/api/v4/collections/1/contents",
    ])
    // The article was already seen in folder 2; saving it again elsewhere is not a new favorite.
    expect(checked).toMatchObject({ status: "entries_published", publishedCount: 2 })
    const [entry, post] = (await service.listEntries(source.id, 5))!
    expect(post).toMatchObject({
      title: "A short post",
      url: "https://www.zhihu.com/pin/13",
      summary: "想法·Poster｜收藏夹：读书｜A short post in full",
    })
    expect(entry).toMatchObject({
      title: "New answer",
      url: "https://www.zhihu.com/question/2093281358667956789/answer/2096922844882015123",
      occurredAt: "2026-10-01T05:00:00.000Z",
      summary: "回答·Writer｜收藏夹：读书｜About New answer",
    })
    expect(entry!.content).toContain(
      '作者：<a href="https://www.zhihu.com/people/writer">Writer</a>',
    )
    expect(entry!.content).toContain("收藏时间：2026-10-01 13:00")
    expect(entry!.content).toContain("赞同 12 · 评论 3")
  })

  it("maps Zhihu refusals to login and rate limit failures", async () => {
    const { state, service, source } = await setup("favorites")
    state.status = 401
    await expect(
      service.checkSource(source.id, new Date("2026-10-01T00:00:00Z")),
    ).rejects.toMatchObject({ code: "behavior_auth_invalid", statusCode: 503 })
    state.status = 403
    const error = await service
      .checkSource(source.id, new Date("2026-10-02T00:00:00Z"))
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "behavior_rate_limited", statusCode: 429 })
    expect(JSON.stringify([error, await service.getSource(source.id)])).not.toContain(LOGIN)
  })
})
