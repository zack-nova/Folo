import { parseHTML } from "linkedom"
import { describe, expect, it, vi } from "vitest"

import { MemorySupplierRepository } from "../src/memory-repository"
import { noticeFacts, pruneNoticeBoilerplate } from "../src/official-notice"
import { extractDetail, extractJSONList, mergeNoticeFacts } from "../src/web-list-extraction"
import { WebListFetcher } from "../src/web-list-fetcher"
import { WebListService } from "../src/web-list-service"
import type { CreateWebListSourceInput } from "../src/web-list-validation"

const now = new Date("2026-10-02T00:00:00Z")
const html = (body: string) => `<html><head><title>T</title></head><body>${body}</body></html>`
const bodyText = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim()
const paragraphs = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `<p>第${index + 1}条 本办法适用于全市范围内的相关活动。</p>`,
  ).join("")

const setup = (fetchImplementation: typeof fetch) => {
  const repository = new MemorySupplierRepository(Buffer.alloc(32, 3))
  const fetcher = new WebListFetcher({
    fetchImplementation,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    maxBytes: 1024 * 1024,
    requestDelayMs: 0,
    timeoutMs: 1000,
  })
  return { service: new WebListService(repository, fetcher) }
}
const htmlResponse = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })

describe("official notice facts", () => {
  it("reads meta tags first, then labelled lines beside the body, and the document number", () => {
    const { document } = parseHTML(
      `<html><head><meta name="PubDate" content="2026-09-30 10:00"><meta name="ContentSource" content="国家发展改革委"></head><body><div><div class="art-tit"><p><em>发布时间：2026-09-29</em><em>来源：办公厅</em></p></div><div id="body"><p>发改价格〔2026〕1303号</p><p>正文内容</p></div></div></body></html>`,
    )
    const root = document.querySelector("#body")!

    expect(noticeFacts(document, root, "关于成本核算的通知")).toEqual({
      facts: [
        ["来源", "国家发展改革委"],
        ["文号", "发改价格〔2026〕1303号"],
      ],
      publishedText: "2026-09-30 10:00",
    })
  })

  it("falls back to labelled lines in the title block when no meta exists", () => {
    const { document } = parseHTML(
      html(
        `<form><div class="art-tit"><h3>论坛通知</h3><p><em>作者：</em><em>发布时间：2026-10-01</em><em>阅读：12</em></p></div><div id="vsb_content"><p>正文</p></div></form>`,
      ),
    )
    expect(noticeFacts(document, document.querySelector("#vsb_content")!, "论坛通知")).toEqual({
      facts: [],
      publishedText: "2026-10-01",
    })
  })
})

describe("official notice boilerplate", () => {
  it("removes toolbars and metadata lines and stops at navigation and footers", () => {
    const { document } = parseHTML(
      html(
        `<div id="body"><div class="tools">【打印】【关闭】</div><p>字号：大 中 小</p><p>发布时间：2026-09-01 来源：市政府 浏览次数：3</p>${paragraphs(3)}<p>上一篇：旧通知</p><p>下一篇：新通知</p><p>不应保留</p></div><div>版权所有 © 某市人民政府</div>`,
      ),
    )
    const root = document.querySelector("#body")!
    pruneNoticeBoilerplate(root)

    expect(bodyText(root)).toBe(
      [1, 2, 3].map((index) => `第${index}条 本办法适用于全市范围内的相关活动。`).join(""),
    )
  })

  it("cuts at a footer only in the back half of the body", () => {
    const { document } = parseHTML(
      html(
        `<div id="body"><p>第一条 作品著作权人版权所有，依法受保护。</p>${paragraphs(6)}<div class="foot">主办单位：某市人民政府 网站地图 联系我们</div><p>页脚链接</p></div>`,
      ),
    )
    const root = document.querySelector("#body")!
    pruneNoticeBoilerplate(root)

    expect(bodyText(root)).toContain("作品著作权人版权所有")
    expect(bodyText(root)).toContain("第6条")
    expect(bodyText(root)).not.toMatch(/主办单位|页脚链接/)
  })
})

describe("official notice detail rendering", () => {
  const source = {
    detail: { contentSelectors: ["#body"], enabled: true, ignoreSelectors: [] },
    timeZone: "Asia/Shanghai",
  } as unknown as Parameters<typeof extractDetail>[1]

  it("renders configured facts first, fills in page facts, dates and nearby attachments", () => {
    const result = extractDetail(
      html(
        `<div class="article"><p>发布时间：2026年9月30日</p><div id="body">${paragraphs(2)}<p><a href="/files/inside.pdf">正文附件</a></p></div><div class="fj"><a href="/files/list.xlsx">附件1：名单</a><a href="/files/inside.pdf">重复</a><a href="/other.html">相关新闻</a></div></div>`,
      ),
      source,
      "https://www.example.gov.cn/notice/1.html",
      "关于印发办法的通知（市政发〔2026〕8号）",
      undefined,
      {
        metadata: [
          ["文号", "市政发〔2026〕8号"],
          ["发文机关", "市人民政府"],
        ],
        now,
      },
    )

    expect(result.facts).toEqual([
      ["文号", "市政发〔2026〕8号"],
      ["发文机关", "市人民政府"],
    ])
    expect(result.publishedAt).toBe("2026-09-29T16:00:00.000Z")
    expect(result.content).toMatch(
      /^<p><strong>文号<\/strong>：市政发〔2026〕8号<\/p><p><strong>发文机关<\/strong>：市人民政府<\/p><p>第1条/,
    )
    expect(result.content).toContain(
      '<a href="https://www.example.gov.cn/files/inside.pdf">正文附件</a>',
    )
    expect(result.content).toMatch(
      /<p><strong>附件<\/strong><\/p><ul><li><a href="https:\/\/www.example.gov.cn\/files\/list.xlsx">附件1：名单<\/a><\/li><\/ul>$/,
    )
    expect(result.content).not.toContain("发布时间")
  })

  it("merges facts without repeating a label or a value", () => {
    expect(
      mergeNoticeFacts(
        [["发文机关", "工业和信息化部"]],
        [
          ["来源", "工业和信息化部"],
          ["文号", "工信部〔2026〕1号"],
        ],
      ),
    ).toEqual([
      ["发文机关", "工业和信息化部"],
      ["文号", "工信部〔2026〕1号"],
    ])
  })
})

describe("official notice items", () => {
  const input: CreateWebListSourceInput = {
    detail: { enabled: true, contentSelectors: ["#body"] },
    format: "json",
    json: {
      metadataPaths: { 发文机关: "dept", 文号: "number" },
      publishedAtPath: "date",
      titlePath: "title",
      urlPath: "url",
    },
    name: "Policies",
    targetURL: "https://www.example.gov.cn/list.json",
    timeZone: "Asia/Shanghai",
  }

  it("extracts configured JSON facts as plain text", async () => {
    const { service } = setup(vi.fn<typeof fetch>())
    const source = await service.createSource(input, "test")
    const [item] = extractJSONList(
      JSON.stringify([{ dept: "<b>市政府</b>", number: "", title: "A", url: "/a.html" }]),
      (await service.getSource(source.id))!,
      now,
    )
    expect(item?.metadata).toEqual([["发文机关", "市政府"]])
  })

  it("uses the detail date for undated items and keeps facts when the detail fails", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([
          { dept: "市政府", number: "市政发〔2026〕8号", title: "A", url: "/a.html" },
          { dept: "市政府", title: "B", url: "/b.html" },
        ]),
      )
      .mockResolvedValueOnce(
        htmlResponse(
          html(`<div><p>发布日期：2026-09-28</p><div id="body">${paragraphs(1)}</div></div>`),
        ),
      )
      .mockRejectedValueOnce(new Error("offline"))
    const { service } = setup(fetchImplementation)
    const source = await service.createSource(input, "test")

    await service.checkSource(source.id, now)
    const items = await service.listItems(source.id, 10)
    const first = items?.find((item) => item.title === "A")
    const second = items?.find((item) => item.title === "B")

    expect(first).toMatchObject({
      detailStatus: "fetched",
      publishedAt: "2026-09-27T16:00:00.000Z",
    })
    expect(first?.content).toMatch(
      /^<p><strong>发文机关<\/strong>：市政府<\/p><p><strong>文号<\/strong>/,
    )
    expect(second).toMatchObject({
      content: "<p><strong>发文机关</strong>：市政府</p>",
      detailStatus: "failed",
      publishedAt: null,
    })
  })
})
