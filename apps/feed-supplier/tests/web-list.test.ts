import { describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import { MemorySupplierRepository } from "../src/memory-repository"
import { PageChangeService } from "../src/page-change-service"
import { PageFetcher } from "../src/page-fetcher"
import { decodeBody, SafeHTTPClient } from "../src/safe-http"
import { buildFeedSupplier } from "../src/server"
import {
  extractDetail,
  extractHTMLList,
  extractJSONList,
  parseListDate,
  resolveJSONPath,
} from "../src/web-list-extraction"
import { WebListFetcher } from "../src/web-list-fetcher"
import type { StoredWebListSource } from "../src/web-list-repository"
import { WebListService } from "../src/web-list-service"
import type { CreateWebListSourceInput } from "../src/web-list-validation"
import { validateWebListInput } from "../src/web-list-validation"

const now = new Date("2026-09-02T00:00:00Z")
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }]
const input: CreateWebListSourceInput = {
  name: "Notices",
  targetURL: "https://example.com/notices/",
  format: "html",
  html: {},
}
const response = (html: string, headers: Record<string, string> = {}) =>
  new Response(html, { headers: { "content-type": "text/html", ...headers } })
const list = (...urls: string[]) =>
  `<html><body><ul>${urls.map((url) => `<li><a href="${url}">Notice ${url}</a> 2026-09-01</li>`).join("")}</ul></body></html>`
const setup = (
  fetchImplementation: typeof fetch = vi.fn<typeof fetch>(),
  options: { timeoutMs?: number } = {},
) => {
  const repository = new MemorySupplierRepository(Buffer.alloc(32, 3))
  const fetcher = new WebListFetcher({
    fetchImplementation,
    lookup: publicLookup,
    maxBytes: 5 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 1000,
    requestDelayMs: 0,
  })
  return { repository, fetcher, service: new WebListService(repository, fetcher) }
}
const sourceFor = async (
  overrides: Partial<CreateWebListSourceInput> = {},
): Promise<StoredWebListSource> => {
  const { service, repository } = setup()
  const source = await service.createSource({ ...input, ...overrides }, "test")
  return (await repository.findWebListSource(source.id))!
}

describe("web list pure extraction", () => {
  it.each([
    ["2026-09-01", "2026-09-01T00:00:00.000Z"],
    ["2026/09/01 08:30", "2026-09-01T08:30:00.000Z"],
    ["2026.09.01 08:30:05", "2026-09-01T08:30:05.000Z"],
    ["2026年9月1日", "2026-09-01T00:00:00.000Z"],
    ["2026年9月1日 08:30", "2026-09-01T08:30:00.000Z"],
    ["2026-09-01T08:30:00+08:00", "2026-09-01T00:30:00.000Z"],
    ["Tue, 01 Sep 2026 08:30:00 +0800", "2026-09-01T00:30:00.000Z"],
    ["[09-01]", "2026-09-01T00:00:00.000Z"],
    ["12-31", "2025-12-31T00:00:00.000Z"],
    ["2026-09-04", null],
    ["2026-02-30", null],
    ["nonsense", null],
  ])("parses date %s", (text, expected) => expect(parseListDate(text, "UTC", now)).toBe(expected))
  it("interprets local time in the source zone and uses its current year", () => {
    expect(parseListDate("2026-09-01 08:30", "Asia/Shanghai", now)).toBe("2026-09-01T00:30:00.000Z")
    expect(parseListDate("01-01", "Asia/Shanghai", new Date("2025-12-31T20:00:00Z"))).toBe(
      "2025-12-31T16:00:00.000Z",
    )
    expect(parseListDate("2026-03-08 02:30", "America/New_York", now)).toBeNull()
  })
  it.each([
    ["", [{ data: [{ title: "a" }, { title: "b" }] }]],
    ["data", [[{ title: "a" }, { title: "b" }]]],
    ["data[0].title", ["a"]],
    ["data[].title", ["a", "b"]],
    ["data[8].title", []],
    ["missing", []],
    ["data..title", []],
  ])("resolves JSON path %s", (path, expected) => {
    expect(resolveJSONPath({ data: [{ title: "a" }, { title: "b" }] }, path)).toEqual(expected)
  })
  it("resolves nested wildcards and array roots", () => {
    expect(
      resolveJSONPath([{ rows: [{ n: 1 }, { n: 2 }] }, { rows: [{ n: 3 }] }], "[].rows[].n"),
    ).toEqual([1, 2, 3])
    expect(resolveJSONPath(["a"], "[0]")).toEqual(["a"])
  })
  it("auto-detects the largest content group, excluding navigation and preserving ties", async () => {
    const source = await sourceFor()
    const html = `<nav>${list("/n1", "/n2", "/n3", "/n4")}</nav><div class="sidebar">${list("/s1", "/s2", "/s3")}</div>${list("a#x", "b")}${list("c", "d")}`
    expect(
      extractHTMLList(html, source, source.targetURL, now).items.map((item) => item.url),
    ).toEqual(["https://example.com/notices/a", "https://example.com/notices/b"])
  })
  it("uses selectors, full title attributes, summaries, filters and URL deduplication", async () => {
    const source = await sourceFor({
      html: {
        itemSelector: "li",
        linkSelector: "a.notice",
        summarySelector: ".summary",
        dateSelector: "time",
      },
      filters: {
        includeURLPatterns: ["example.com"],
        excludeURLPatterns: ["/skip"],
        includeTextPatterns: ["Notice"],
        excludeTextPatterns: ["Draft"],
      },
    })
    const html = `<ul><li><a href="/wrong">other</a><a class="notice" href="../one#fragment" title="Notice complete title">Notice...</a><span class="summary">Summary</span><time>2026/09/01</time></li><li><a class="notice" href="/one">Notice duplicate</a></li><li><a class="notice" href="/skip">Notice skip</a></li><li><a class="notice" href="/draft">Notice Draft</a></li><li><a class="notice" href="javascript:alert(1)">Notice unsafe</a></li><li><a class="notice" href="mailto:x@example.com">Notice email</a></li></ul>`
    expect(extractHTMLList(html, source, source.targetURL, now).items).toEqual([
      {
        title: "Notice complete title",
        summary: "Summary",
        url: "https://example.com/one",
        identity: "https://example.com/one",
        publishedAt: "2026-09-01T00:00:00.000Z",
      },
    ])
  })
  it("supports anchors as items, title selectors, empty anchor fallback and top maxItems", async () => {
    const source = await sourceFor({
      html: { itemSelector: "a", titleSelector: "span" },
      maxItems: 1,
    })
    expect(
      extractHTMLList(
        '<a href="/a"><span>Chosen</span></a><a href="/b"><span>Second</span></a>',
        source,
        source.targetURL,
        now,
      ).items[0]?.title,
    ).toBe("Chosen")
    const fallback = await sourceFor({ html: { itemSelector: "li" } })
    expect(
      extractHTMLList('<li><a href="/a"></a>Item title</li>', fallback, fallback.targetURL, now)
        .items[0]?.title,
    ).toBe("Item title")
  })
  it("extracts JSON arrays, templates, identities, summaries and unix seconds", async () => {
    const source = await sourceFor({
      format: "json",
      html: null,
      json: {
        itemsPath: "data[]",
        titlePath: "title",
        urlTemplate: "/notice/{id}",
        idPath: "id",
        summaryPath: "summary",
        publishedAtPath: "date",
        publishedAtFormat: "unix_seconds",
      },
    })
    const items = extractJSONList(
      JSON.stringify({
        data: [{ title: "通知", id: "a /中", summary: "中".repeat(2000), date: 1788220800 }],
      }),
      source,
      now,
    )
    expect(items[0]).toMatchObject({
      title: "通知",
      url: "https://example.com/notice/a%20%2F%E4%B8%AD",
      identity: "id:a /中",
      publishedAt: "2026-09-01T00:00:00.000Z",
    })
    expect(Buffer.byteLength(items[0]!.summary!)).toBeLessThanOrEqual(4096)
    expect(items[0]!.summary).not.toContain("�")
  })
  it("extracts JSON root, relative urlBase and unix milliseconds, rejecting invalid JSON", async () => {
    const source = await sourceFor({
      format: "json",
      html: null,
      json: {
        titlePath: "title",
        urlPath: "url",
        urlBase: "https://other.example/base/",
        publishedAtPath: "date",
        publishedAtFormat: "unix_milliseconds",
      },
    })
    expect(
      extractJSONList('[{"title":"A","url":"a","date":1788220800000}]', source, now)[0],
    ).toMatchObject({
      url: "https://other.example/base/a",
      publishedAt: "2026-09-01T00:00:00.000Z",
    })
    expect(() => extractJSONList("bad json", source, now)).toThrow(
      expect.objectContaining({ code: "web_list_json_invalid" }),
    )
  })
  it("sanitizes details, resolves URLs, unwraps unknown elements and recovers h1 titles", async () => {
    const source = await sourceFor({
      detail: { enabled: true, contentSelectors: [".missing", "main"], ignoreSelectors: [".ads"] },
    })
    const result = extractDetail(
      '<html><body><main><h1>Notice full heading</h1><script>bad()</script><p onclick="evil()">Hello <custom>kept</custom><a href="javascript:evil()">bad link</a><a href="/good">good</a><img src="../image.png" alt="photo" onerror="evil()"></p><p> </p><div class="ads">ad</div><iframe>bad</iframe></main></body></html>',
      source,
      "https://example.com/details/a",
      "Notice...",
    )
    expect(result.title).toBe("Notice full heading")
    expect(result.content).toContain('<img src="https://example.com/image.png" alt="photo">')
    expect(result.content).toContain('<a href="https://example.com/good">good</a>')
    expect(result.content).toContain("Hello kept<a>bad link</a>")
    expect(result.content).not.toMatch(
      /script|onclick|onerror|javascript|iframe|custom|class=|<p> <\/p>/,
    )
  })
  it("bounds sanitized HTML at a valid text boundary with balanced elements", async () => {
    const result = extractDetail(
      `<html><body><article><div><p>${"通知<&".repeat(60000)}</p></div></article></body></html>`,
      await sourceFor(),
      "https://example.com/a",
      "A",
    )
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(131072)
    expect(result.content).toMatch(/<\/p><\/div><p>\[Content truncated\]<\/p>$/)
    expect(result.content).not.toContain("�")
  })
})

describe("safe list fetching", () => {
  it.each(["gbk", "gb2312", "x-gbk"])("decodes %s bytes", (label) =>
    expect(
      decodeBody(Uint8Array.from([0xcd, 0xa8, 0xd6, 0xaa]), `text/html; charset=${label}`),
    ).toBe("通知"),
  )
  it("detects meta charset, http-equiv, BOM and unknown labels", () => {
    const bytes = Buffer.concat([
      Buffer.from('<meta charset="gbk">'),
      Buffer.from([0xcd, 0xa8, 0xd6, 0xaa]),
    ])
    expect(decodeBody(bytes)).toContain("通知")
    const equiv = Buffer.concat([
      Buffer.from('<meta content="text/html; charset=gb2312" http-equiv="Content-Type">'),
      Buffer.from([0xcd, 0xa8, 0xd6, 0xaa]),
    ])
    expect(decodeBody(equiv)).toContain("通知")
    expect(decodeBody(Buffer.from([0xff, 0xfe, 0x41, 0]))).toBe("A")
    expect(decodeBody(Buffer.from("通知"), "text/plain; charset=unknown-label")).toBe("通知")
    expect(decodeBody(bytes, "text/html; charset=utf-8")).not.toContain("通知")
  })
  it("decodes GBK in both web list and page-change fetchers", async () => {
    const bytes = Buffer.concat([
      Buffer.from('<html><body><main><ul><li><a href="/notice">'),
      Buffer.from([0xcd, 0xa8, 0xd6, 0xaa]),
      Buffer.from("</a></li></ul></main></body></html>"),
    ])
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(bytes, { headers: { "content-type": "text/html; charset=gbk" } }),
      )
    const { fetcher } = setup(fetchImplementation)
    expect(
      (await fetcher.fetch(await sourceFor({ html: { itemSelector: "li" } }), now)).items[0]?.title,
    ).toBe("通知")
    const repository = new MemorySupplierRepository(Buffer.alloc(32))
    const service = new PageChangeService(
      repository,
      new PageFetcher({
        fetchImplementation,
        lookup: publicLookup,
        maxBytes: 4096,
        maxContentBytes: 4096,
        timeoutMs: 1000,
      }),
    )
    const source = await service.createSource(
      { name: "GBK", targetURL: "https://example.com" },
      "test",
    )
    expect((await service.testSource(source.id, "test"))?.excerpt).toBe("通知")
  })
  it("follows pagination, excludes next links, deduplicates and stops repeats", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(`${list("/a", "/b")}<a href="/page2">下一页</a>`, { etag: '"first"' }),
      )
      .mockResolvedValueOnce(
        response(`${list("/b", "/c")}<a href="https://example.com/notices/">Next</a>`),
      )
    const { fetcher } = setup(mock)
    const source = await sourceFor({ maxPages: 10 })
    source.etag = '"old"'
    const result = await fetcher.fetch(source, now)
    expect(result.items.map((item) => item.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ])
    expect(result.pagesRead).toBe(2)
    expect(result.etag).toBe('"first"')
    expect(mock).toHaveBeenCalledTimes(2)
    expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get("if-none-match")).toBe('"old"')
    expect(new Headers(mock.mock.calls[1]?.[1]?.headers).has("if-none-match")).toBe(false)
  })
  it("keeps collected items when a later page fails and clears cache eligibility", async () => {
    const { fetcher } = setup(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(`${list("/a", "/b")}<a href="/page2">next</a>`))
        .mockRejectedValueOnce(new Error("offline")),
    )
    expect(await fetcher.fetch(await sourceFor({ maxPages: 3 }), now)).toMatchObject({
      complete: false,
      pagesRead: 1,
      items: [{ title: "Notice /a" }, { title: "Notice /b" }],
    })
  })
  it("follows meta refresh and resolves links against the final URL", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('<meta http-equiv="refresh" content="0;url=/new/">'))
      .mockResolvedValueOnce(response(list("a", "b")))
    const { fetcher } = setup(mock)
    const result = await fetcher.fetch(await sourceFor(), now)
    expect(result.finalURL).toBe("https://example.com/new/")
    expect(result.pagesRead).toBe(1)
    expect(result.items[0]?.url).toBe("https://example.com/new/a")
  })
  it("rejects a fourth meta refresh", async () => {
    let call = 0
    const { fetcher } = setup(
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          response(`<meta http-equiv="refresh" content="0;url=/page${++call}">`),
        ),
    )
    await expect(fetcher.fetch(await sourceFor())).rejects.toMatchObject({
      code: "web_list_refresh_limit",
    })
  })
  it("accepts JSON served as text/html and sends JSON accept", async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(response('[{"title":"A","url":"/a"}]'))
    const { fetcher } = setup(mock)
    expect(
      (
        await fetcher.fetch(
          await sourceFor({
            format: "json",
            html: null,
            json: { titlePath: "title", urlPath: "url" },
          }),
          now,
        )
      ).items,
    ).toHaveLength(1)
    expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get("accept")).toBe(
      "application/json, text/plain;q=0.9, */*;q=0.1",
    )
  })
  it.each([
    "http://127.0.0.1/a",
    "http://[::ffff:127.0.0.1]/a",
    "http://169.254.169.254/a",
    "http://localhost/a",
  ])("blocks private list and detail URL %s", async (url) => {
    const mock = vi.fn<typeof fetch>()
    const { fetcher } = setup(mock)
    const source = await sourceFor({ targetURL: url })
    await expect(fetcher.fetch(source)).rejects.toMatchObject({ code: "page_private_address" })
    expect(
      await fetcher.detail(
        { title: "A", url, identity: url, publishedAt: null, summary: null },
        source,
      ),
    ).toMatchObject({ detailStatus: "failed" })
    expect(mock).not.toHaveBeenCalled()
  })
  it("revalidates HTTP and meta redirects", async () => {
    for (const redirect of [
      new Response(null, { status: 302, headers: { location: "http://localhost/a" } }),
      response('<meta http-equiv="refresh" content="0;url=http://localhost/a">'),
    ]) {
      const mock = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect)
      await expect(setup(mock).fetcher.fetch(await sourceFor())).rejects.toMatchObject({
        code: "page_private_address",
      })
      expect(mock).toHaveBeenCalledTimes(1)
    }
  })
  it("rejects mixed DNS answers, oversized bodies and redirect overflow", async () => {
    const mock = vi.fn<typeof fetch>()
    const client = new SafeHTTPClient({
      fetchImplementation: mock,
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      maxBytes: 10,
      timeoutMs: 1000,
    })
    await expect(client.get("https://example.com")).rejects.toMatchObject({
      code: "page_private_address",
    })
    expect(mock).not.toHaveBeenCalled()
    const bounded = new SafeHTTPClient({
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(response("a".repeat(20))),
      lookup: publicLookup,
      maxBytes: 10,
      timeoutMs: 1000,
    })
    await expect(bounded.get("https://example.com")).rejects.toMatchObject({
      code: "page_too_large",
    })
    const redirects = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(null, { status: 302, headers: { location: "/redirect" } }),
      )
    const redirectClient = new SafeHTTPClient({
      fetchImplementation: redirects,
      lookup: publicLookup,
      maxBytes: 10,
      timeoutMs: 1000,
    })
    await expect(redirectClient.get("https://example.com")).rejects.toMatchObject({
      code: "page_redirect_limit",
    })
    expect(redirects).toHaveBeenCalledTimes(6)
  })
})

describe("web list state machine", () => {
  it("publishes all initial items, then only new identities, then honors 304", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(list("/a", "/b"), { etag: '"one"' }))
      .mockResolvedValueOnce(response(list("/c", "/a", "/b"), { etag: '"two"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const { service, repository } = setup(mock)
    const source = await service.createSource(input, "owner")
    expect(await service.checkSource(source.id, now)).toMatchObject({
      status: "items_published",
      publishedCount: 2,
    })
    const before = await service.listItems(source.id, 100)
    expect(await service.checkSource(source.id, now)).toMatchObject({
      status: "items_published",
      publishedCount: 1,
      source: { itemCount: 3 },
    })
    expect(await service.checkSource(source.id, now)).toMatchObject({
      status: "unchanged",
      publishedCount: 0,
    })
    expect(await service.listItems(source.id, 100)).toEqual(expect.arrayContaining(before!))
    expect((await repository.findWebListSource(source.id))?.etag).toBe('"two"')
    expect(new Headers(mock.mock.calls[2]?.[1]?.headers).get("if-none-match")).toBe('"two"')
    expect(before?.[0]?.guid).toMatch(/^urn:folo:web-list:[\da-f-]+:[\da-f]{32}$/)
  })
  it("returns unchanged on a 200 containing only known items", async () => {
    const { service } = setup(
      vi.fn<typeof fetch>().mockImplementation(async () => response(list("/a", "/b"))),
    )
    const source = await service.createSource(input, "test")
    await service.checkSource(source.id, now)
    expect(await service.checkSource(source.id, now)).toMatchObject({
      status: "unchanged",
      publishedCount: 0,
    })
  })
  it("backs off empty lists and resets failures after success", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response("<body>empty</body>"))
      .mockResolvedValueOnce(response("<body>empty</body>"))
      .mockResolvedValueOnce(response(list("/a", "/b")))
    const { service } = setup(mock)
    const source = await service.createSource(
      { ...input, enabled: true, intervalMinutes: 15 },
      "test",
    )
    await expect(service.checkSource(source.id, now)).rejects.toMatchObject({
      code: "web_list_no_items",
    })
    expect(await service.getSource(source.id)).toMatchObject({
      consecutiveFailures: 1,
      lastErrorCode: "web_list_no_items",
      nextCheckAt: "2026-09-02T00:15:00.000Z",
    })
    expect(await service.runDueCycle(new Date("2026-09-02T00:15:00Z"))).toEqual({
      checked: 1,
      failed: 1,
    })
    expect(await service.getSource(source.id)).toMatchObject({
      consecutiveFailures: 2,
      nextCheckAt: "2026-09-02T00:45:00.000Z",
    })
    await service.checkSource(source.id, now)
    expect(await service.getSource(source.id)).toMatchObject({
      consecutiveFailures: 0,
      lastErrorCode: null,
    })
  })
  it("rejects concurrent checks with 409", async () => {
    let finish: (value: Response) => void = () => {
      throw new Error("Fetch has not started")
    }
    const { service } = setup(
      vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
    )
    const source = await service.createSource(input, "test")
    const first = service.checkSource(source.id, now)
    await vi.waitFor(() => expect(finish.toString()).not.toContain("Fetch has not started"))
    await expect(service.checkSource(source.id, now)).rejects.toMatchObject({
      statusCode: 409,
      code: "web_list_check_in_progress",
    })
    finish(response(list("/a", "/b")))
    await first
  })
  it("publishes failed details and skips non-HTML attachments", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(list("/a", "/b")))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response("pdf", { headers: { "content-type": "application/pdf" } }),
      )
    const { service } = setup(mock)
    const source = await service.createSource({ ...input, detail: { enabled: true } }, "test")
    expect(await service.checkSource(source.id, now)).toMatchObject({ publishedCount: 2 })
    expect(await service.listItems(source.id, 20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detailStatus: "failed", content: null }),
        expect.objectContaining({ detailStatus: "skipped", content: null }),
      ]),
    )
  })
  it("fetches only new details and publishes sanitized content", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('<li><a href="/a">Notice...</a></li>'))
      .mockResolvedValueOnce(
        response("<main><h1>Notice full title</h1><p>Content &amp; text</p></main>"),
      )
      .mockResolvedValueOnce(response('<li><a href="/a">Notice...</a></li>'))
    const { service } = setup(mock)
    const source = await service.createSource(
      { ...input, html: { itemSelector: "li" }, detail: { enabled: true } },
      "test",
    )
    await service.checkSource(source.id, now)
    await service.checkSource(source.id, now)
    expect(mock).toHaveBeenCalledTimes(3)
    expect((await service.listItems(source.id, 20))?.[0]).toMatchObject({
      title: "Notice full title",
      detailStatus: "fetched",
      content: "<h1>Notice full title</h1><p>Content &amp; text</p>",
    })
    const feed = await service.materializeFeed(source.feedURL)
    expect(feed.body).toContain("&lt;p&gt;Content &amp;amp; text&lt;/p&gt;")
    expect(feed.body).toContain("<category>web-list</category>")
  })
  it("defers unstarted details when the total budget is exhausted, without caching the list", async () => {
    const { service, fetcher, repository } = setup(
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => response(list("/a", "/b"), { etag: '"list"' })),
      { timeoutMs: 60000 },
    )
    const initial = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(initial)
    vi.spyOn(fetcher, "detail").mockImplementation(async (item) => {
      clock.mockReturnValue(initial + 61000)
      return { title: item.title, content: "<p>A</p>", detailStatus: "fetched" }
    })
    try {
      const source = await service.createSource({ ...input, detail: { enabled: true } }, "test")
      expect(await service.checkSource(source.id, now)).toMatchObject({ publishedCount: 1 })
      expect((await repository.findWebListSource(source.id))?.etag).toBeNull()
      expect(await service.listItems(source.id, 100)).toHaveLength(1)
      clock.mockReturnValue(initial)
      expect(await service.checkSource(source.id, now)).toMatchObject({ publishedCount: 1 })
      expect(await service.listItems(source.id, 100)).toHaveLength(2)
    } finally {
      clock.mockRestore()
    }
  })
  it("keeps history across configuration edits and resets conditional state", async () => {
    const { service, repository } = setup(
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => response(list("/a", "/b"), { etag: '"cached"' })),
    )
    const source = await service.createSource(
      { ...input, enabled: true, intervalMinutes: 15 },
      "test",
    )
    await service.checkSource(source.id, now)
    await service.updateSource(
      source.id,
      { targetURL: "https://example.com/new/", filters: { excludeTextPatterns: ["skip"] } },
      "test",
    )
    const updated = await repository.findWebListSource(source.id)
    expect(updated).toMatchObject({ etag: null, lastModified: null, itemCount: 2 })
    expect(updated?.nextCheckAt).not.toBe("2026-09-02T00:15:00.000Z")
    expect(await service.listItems(source.id, 100)).toHaveLength(2)
  })
  it("previews statelessly and fetches only the first detail when requested", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(list("/a", "/b")))
      .mockResolvedValueOnce(response(list("/a", "/b")))
      .mockResolvedValueOnce(response("<main><p>Detail</p></main>"))
    const { service, repository } = setup(mock)
    const source = await service.createSource({ ...input, detail: { enabled: true } }, "test")
    expect((await service.testSource(source.id, "test"))?.detail).toBeNull()
    expect(mock).toHaveBeenCalledTimes(1)
    expect((await service.testSource(source.id, "test", true))?.detail?.content).toBe(
      "<p>Detail</p>",
    )
    expect(mock).toHaveBeenCalledTimes(3)
    expect(await service.listItems(source.id, 100)).toEqual([])
    expect(await repository.findWebListSource(source.id)).toMatchObject({
      lastAttemptAt: null,
      etag: null,
    })
    expect(
      (await repository.listAuditEvents(0, 100)).filter(
        (event) => event.action === "web_list_source.tested",
      ),
    ).toHaveLength(2)
  })
  it("uses configured JSON identities across changed URLs", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('[{"id":1,"title":"A","url":"/a"}]'))
      .mockResolvedValueOnce(response('[{"id":1,"title":"B","url":"/b"}]'))
    const { service } = setup(mock)
    const source = await service.createSource(
      {
        ...input,
        format: "json",
        html: null,
        json: { titlePath: "title", urlPath: "url", idPath: "id" },
      },
      "test",
    )
    await service.checkSource(source.id, now)
    expect(await service.checkSource(source.id, now)).toMatchObject({ publishedCount: 0 })
    expect((await service.listItems(source.id, 20))?.[0]?.url).toBe("https://example.com/a")
  })
})

describe("web list HTTP surface", () => {
  it("enforces auth, validates bodies, exposes CRUD, preview, checks, RSS and providers", async () => {
    const config = loadFeedSupplierConfig({
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
    })
    const mock = vi.fn<typeof fetch>().mockImplementation(async () => response(list("/a", "/b")))
    const { repository, fetcher } = setup(mock)
    const server = await buildFeedSupplier({
      config,
      repository,
      webListFetcher: fetcher,
      fetchImplementation: vi.fn<typeof fetch>().mockImplementation(async () => new Response("ok")),
    })
    const headers = { authorization: `Bearer ${config.adminToken}` }
    const internal = { authorization: `Bearer ${config.internalToken}` }
    const base = "/v1/admin/web-list-sources"
    try {
      for (const authorization of [{}, internal])
        expect((await server.inject({ url: base, headers: authorization })).statusCode).toBe(401)
      for (const [patch, code] of [
        [{ html: { itemSelector: "[" } }, "web_list_selector_invalid"],
        [{ filters: { includeURLPatterns: ["["] } }, "web_list_pattern_invalid"],
        [{ filters: { includeTextPatterns: ["x".repeat(257)] } }, "web_list_pattern_invalid"],
        [
          { filters: { excludeURLPatterns: Array.from({ length: 17 }, () => "x") } },
          "web_list_pattern_invalid",
        ],
        [{ timeZone: "Not/AZone" }, "web_list_time_zone_invalid"],
        [{ format: "json" }, "web_list_extraction_invalid"],
        [{ json: { titlePath: "title", urlPath: "url" } }, "web_list_extraction_invalid"],
        [{ unknown: true }, "invalid_request"],
        [{ targetURL: "https://user:pass@example.com" }, "web_list_url_invalid"],
        [{ targetURL: "https://example.com?token=secret" }, "web_list_url_secret_forbidden"],
      ] as const) {
        const result = await server.inject({
          method: "POST",
          url: base,
          headers,
          payload: { ...input, ...patch },
        })
        expect(result.statusCode, result.body).toBe(400)
        expect(result.json().code).toBe(code)
      }
      const created = await server.inject({ method: "POST", url: base, headers, payload: input })
      expect(created.statusCode, created.body).toBe(201)
      const source = created.json<{ source: StoredWebListSource }>().source
      expect(source).not.toHaveProperty("etag")
      expect(
        (
          await server.inject({
            method: "POST",
            url: base,
            headers,
            payload: { ...input, name: "notices" },
          })
        ).statusCode,
      ).toBe(409)
      expect(
        (await server.inject({ method: "GET", url: base, headers })).json().sources,
      ).toHaveLength(1)
      expect(
        (await server.inject({ method: "GET", url: `${base}/${source.id}`, headers })).statusCode,
      ).toBe(200)
      expect(
        (
          await server.inject({
            method: "PATCH",
            url: `${base}/${source.id}`,
            headers,
            payload: { timeZone: "bad zone" },
          })
        ).statusCode,
      ).toBe(400)
      expect(
        (
          await server.inject({
            method: "PATCH",
            url: `${base}/${source.id}`,
            headers,
            payload: { name: "New name" },
          })
        ).statusCode,
      ).toBe(200)
      expect(
        (await server.inject({ method: "POST", url: `${base}/${source.id}/test`, headers })).json()
          .items,
      ).toHaveLength(2)
      expect(
        (await server.inject({ method: "POST", url: `${base}/${source.id}/check`, headers })).json()
          .publishedCount,
      ).toBe(2)
      expect(
        (await server.inject({ url: `${base}/${source.id}/items?limit=1`, headers })).json().items,
      ).toHaveLength(1)
      expect(
        (await server.inject({ url: `${base}/${source.id}/items?limit=101`, headers })).statusCode,
      ).toBe(400)
      const calls = mock.mock.calls.length
      const feedURL = `/v1/feeds/web-list?url=${encodeURIComponent(source.feedURL)}`
      const feed = await server.inject({ url: feedURL, headers: internal })
      expect(feed.statusCode).toBe(200)
      expect(feed.body).toContain('<guid isPermaLink="false">urn:folo:web-list:')
      expect(feed.body).toContain("<link>https://example.com/a</link>")
      expect(feed.headers["x-folo-upstream-url"]).toBe(input.targetURL)
      expect(feed.headers["last-modified"]).toBeTruthy()
      expect(
        (
          await server.inject({
            url: feedURL,
            headers: { ...internal, "if-none-match": String(feed.headers.etag) },
          })
        ).statusCode,
      ).toBe(304)
      expect(mock).toHaveBeenCalledTimes(calls)
      expect(
        (await server.inject({ url: "/v1/feeds/web-list?url=bad", headers: internal })).statusCode,
      ).toBe(400)
      const providers = (await server.inject({ url: "/v1/providers", headers: internal })).json()
        .providers
      expect(providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "web_list",
            configured: true,
            enabledSourceCount: 0,
            dueSourceCount: 0,
            status: "ready",
          }),
        ]),
      )
      expect(
        (await server.inject({ method: "DELETE", url: `${base}/${source.id}`, headers }))
          .statusCode,
      ).toBe(204)
      expect((await server.inject({ url: feedURL, headers: internal })).json().code).toBe(
        "web_list_source_not_found",
      )
      expect((await repository.listAuditEvents(0, 100)).map((event) => event.action)).toEqual(
        expect.arrayContaining([
          "web_list_source.created",
          "web_list_source.updated",
          "web_list_source.tested",
          "web_list_source.deleted",
        ]),
      )
    } finally {
      await server.close()
    }
  })
  it("rejects missing and dual JSON URL configuration", () => {
    for (const json of [
      { titlePath: "title" },
      { titlePath: "title", urlPath: "url", urlTemplate: "/{id}" },
    ])
      expect(() => validateWebListInput({ ...input, format: "json", html: null, json })).toThrow(
        expect.objectContaining({ code: "web_list_extraction_invalid" }),
      )
  })
})

describe("web list review regressions", () => {
  it("parses labelled dates from a date selector and fractional ISO seconds", async () => {
    const source = await sourceFor({
      html: { itemSelector: "li", dateSelector: ".date" },
      timeZone: "Asia/Shanghai",
    })
    const { items } = extractHTMLList(
      '<ul><li><a href="/a">Notice A</a><span class="date">发布时间：2026年9月1日</span></li></ul>',
      source,
      "https://example.com/",
      now,
    )
    expect(items[0]?.publishedAt).toBe("2026-08-31T16:00:00.000Z")
    expect(parseListDate("2026-09-01T08:30:05.123", "UTC", now)).toBe("2026-09-01T08:30:05.000Z")
  })

  it("drops tracking parameters from item identities", async () => {
    const source = await sourceFor()
    const { items } = extractHTMLList(
      list("/a?utm_source=mail&id=1&fbclid=x", "/b?gclid=y"),
      source,
      "https://example.com/",
      now,
    )
    expect(items.map((item) => item.url)).toEqual([
      "https://example.com/a?id=1",
      "https://example.com/b",
    ])
  })

  it("prefers government body containers and drops embedded controls", async () => {
    const source = await sourceFor({ detail: { enabled: true } })
    const result = extractDetail(
      `<html><body><div class="wrapper"><div class="share">${"分享到微博 ".repeat(20)}</div><div class="TRS_Editor"><p>第一条 本办法自发布之日起施行，由市人民政府办公厅负责解释。</p><svg><text>icon</text></svg><button>打印</button></div></div></body></html>`,
      source,
      "https://www.example.gov.cn/a.html",
      "办法",
    )
    expect(result.content).toBe(
      "<p>第一条 本办法自发布之日起施行，由市人民政府办公厅负责解释。</p>",
    )
  })

  it("stops emitting content once the size budget is spent", async () => {
    const result = extractDetail(
      `<main><p>${"a".repeat(200)}</p><p>tail</p></main>`,
      await sourceFor(),
      "https://example.com/a",
      "A",
      120,
    )
    expect(result.content).not.toContain("tail")
    expect(result.content).toMatch(/<p>a+<\/p><p>\[Content truncated\]<\/p>$/)
  })

  it("never downloads attachment details and avoids reading non-HTML bodies", async () => {
    let bodyRead = false
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(list("/notice.pdf", "/b")))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                bodyRead = true
                controller.enqueue(new Uint8Array(1024))
                controller.close()
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "application/msword" } },
        ),
      )
    const { service } = setup(mock)
    const source = await service.createSource({ ...input, detail: { enabled: true } }, "test")
    expect(await service.checkSource(source.id, now)).toMatchObject({ publishedCount: 2 })
    expect(mock).toHaveBeenCalledTimes(2)
    expect(String(mock.mock.calls[1]?.[0])).toBe("https://example.com/b")
    expect(bodyRead).toBe(false)
    expect((await service.listItems(source.id, 10))?.map((item) => item.detailStatus)).toEqual([
      "skipped",
      "skipped",
    ])
  })

  it("keeps the list order of undated items discovered in one check", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          '<ul><li><a href="/first">First</a></li><li><a href="/second">Second</a></li><li><a href="/third">Third</a></li></ul>',
        ),
      )
    const { service } = setup(mock)
    const source = await service.createSource(input, "test")
    await service.checkSource(source.id, now)
    expect((await service.listItems(source.id, 10))?.map((item) => item.title)).toEqual([
      "First",
      "Second",
      "Third",
    ])
  })

  it("renders a whitespace-collapsed description from detail content", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(list("/a")))
      .mockResolvedValueOnce(response("<main>\n   <p>  Hello\n   world  </p>\n</main>"))
    const { service } = setup(mock)
    const source = await service.createSource(
      { ...input, html: { itemSelector: "li" }, detail: { enabled: true } },
      "test",
    )
    await service.checkSource(source.id, now)
    const feed = await service.materializeFeed(source.feedURL)
    expect(feed.body).toContain("<description>Hello world</description>")
  })

  it("reports aborted requests as timeouts", async () => {
    const client = new SafeHTTPClient({
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError")),
      lookup: publicLookup,
      maxBytes: 1024,
      timeoutMs: 1000,
    })
    await expect(client.get("https://example.com/")).rejects.toMatchObject({
      code: "page_fetch_timeout",
    })
  })
})

describe("web list JSON text fields", () => {
  it("reduces markup in JSON titles and summaries to plain text", async () => {
    const source = await sourceFor({
      format: "json",
      html: null,
      json: { titlePath: "title", urlPath: "url", summaryPath: "summary" },
    })
    const [item] = extractJSONList(
      JSON.stringify([
        {
          summary: "<p>公示  期五日 &amp; 欢迎监督</p>",
          title: "西安市生态环境保护委员会办公室<br/>关于申报名单的公示",
          url: "/xw/gsgg/1.html",
        },
      ]),
      source,
      now,
    )
    expect(item).toMatchObject({
      summary: "公示 期五日 & 欢迎监督",
      title: "西安市生态环境保护委员会办公室 关于申报名单的公示",
    })
  })
})

describe("web list detail containers", () => {
  it("finds the body inside a page-wide form and drops its controls", async () => {
    const source = await sourceFor({
      detail: { enabled: true, contentSelectors: ["#vsb_content", ".v_news_content"] },
    })
    const result = extractDetail(
      '<html><body><form name="_newscontent_fromname"><div class="nav">首页 学校概况</div><div id="vsb_content"><div class="v_news_content"><p>第一届西北大学中亚研究青年学者论坛将于十月举行。</p><input type="hidden" value="x"></div></div></form></body></html>',
      source,
      "https://www.nwu.edu.cn/info/1227/22448.htm",
      "论坛通知",
    )
    expect(result.content).toBe(
      "<div><p>第一届西北大学中亚研究青年学者论坛将于十月举行。</p></div>",
    )
  })
})

describe("web list detail form controls", () => {
  it("ignores form control text when choosing the body", async () => {
    const result = extractDetail(
      `<html><body><form><div class="comment"><textarea>${"留言 ".repeat(80)}</textarea></div><div class="content">${"正文内容。".repeat(20)}</div></form></body></html>`,
      await sourceFor({ detail: { enabled: true } }),
      "https://example.com/a",
      "A",
    )
    expect(result.content).toContain("正文内容")
    expect(result.content).not.toContain("留言")
  })
})

describe("web list partial updates", () => {
  it("changes only the fields a PATCH sends", async () => {
    const config = loadFeedSupplierConfig({
      INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
      NODE_ENV: "test",
    })
    const { repository, fetcher } = setup(vi.fn<typeof fetch>())
    const server = await buildFeedSupplier({
      config,
      repository,
      webListFetcher: fetcher,
      fetchImplementation: vi.fn<typeof fetch>().mockImplementation(async () => new Response("ok")),
    })
    const headers = { authorization: `Bearer ${config.adminToken}` }
    try {
      const created = await server.inject({
        headers,
        method: "POST",
        payload: {
          ...input,
          detail: { contentSelectors: [".TRS_Editor"], enabled: true },
          filters: { includeURLPatterns: ["/notices/"] },
          html: { itemSelector: ".list li" },
          maxItems: 15,
          timeZone: "Asia/Shanghai",
        },
        url: "/v1/admin/web-list-sources",
      })
      const before = created.json().source
      const patched = await server.inject({
        headers,
        method: "PATCH",
        payload: { enabled: true, intervalMinutes: 360 },
        url: `/v1/admin/web-list-sources/${before.id}`,
      })

      expect(patched.statusCode).toBe(200)
      expect(patched.json().source).toMatchObject({
        detail: { contentSelectors: [".TRS_Editor"], enabled: true, ignoreSelectors: [] },
        enabled: true,
        filters: before.filters,
        html: before.html,
        intervalMinutes: 360,
        maxItems: 15,
        timeZone: "Asia/Shanghai",
      })
    } finally {
      await server.close()
    }
  })
})
