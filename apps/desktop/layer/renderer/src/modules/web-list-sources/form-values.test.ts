import type { WebListSource } from "@follow/feed-source-contracts"
import { describe, expect, it } from "vitest"

import { initialWebListValues, lines, webListInput, webListPatch } from "./form-values"

describe("web list form values", () => {
  it("trims lines, drops blanks, and sends complete nested objects", () => {
    expect(lines("  a\r\n\n b \n")).toEqual(["a", "b"])
    const input = webListInput({
      ...initialWebListValues(),
      name: " News ",
      itemSelector: " article ",
      contentSelectors: " main\n\n article ",
      includeURLPatterns: " /news/ \n",
      maxItems: "30",
      maxPages: "2",
    })
    expect(input).toMatchObject({
      name: "News",
      maxItems: 30,
      maxPages: 2,
      intervalMinutes: null,
      json: null,
      html: {
        itemSelector: "article",
        linkSelector: null,
        titleSelector: null,
        dateSelector: null,
        summarySelector: null,
      },
      detail: { enabled: false, contentSelectors: ["main", "article"], ignoreSelectors: [] },
      filters: {
        includeURLPatterns: ["/news/"],
        excludeURLPatterns: [],
        includeTextPatterns: [],
        excludeTextPatterns: [],
      },
    })
  })
  it("chooses JSON extraction and preserves equals signs in metadata paths", () => {
    const input = webListPatch({
      ...initialWebListValues(),
      format: "json",
      titlePath: " title ",
      metadataPaths: " Number = data.id\n\n Query=key=value ",
      publishedAtFormat: "unix_seconds",
      enabled: true,
    })
    expect(input.html).toBeNull()
    expect(input.json).toEqual({
      itemsPath: "",
      titlePath: "title",
      urlPath: null,
      urlTemplate: null,
      urlBase: null,
      idPath: null,
      summaryPath: null,
      publishedAtPath: null,
      publishedAtFormat: "unix_seconds",
      metadataPaths: { Number: "data.id", Query: "key=value" },
    })
    expect(input.intervalMinutes).toBe(360)
    expect(
      webListInput({ ...initialWebListValues(), intervalMinutes: " 15 " }).intervalMinutes,
    ).toBe(15)
  })
  it("round-trips existing settings without dropping nested values", () => {
    const source: WebListSource = {
      id: "id",
      name: "News",
      targetURL: "https://example.com",
      format: "json",
      html: null,
      json: {
        itemsPath: "data",
        titlePath: "title",
        urlPath: "url",
        urlTemplate: null,
        urlBase: "https://example.com",
        idPath: "id",
        summaryPath: "summary",
        publishedAtPath: "date",
        publishedAtFormat: "unix_milliseconds",
        metadataPaths: { Category: "category" },
      },
      filters: {
        includeTextPatterns: ["news"],
        excludeTextPatterns: ["ad"],
        includeURLPatterns: ["/news"],
        excludeURLPatterns: ["/ad"],
      },
      detail: { enabled: true, contentSelectors: ["main"], ignoreSelectors: ["nav"] },
      enabled: true,
      intervalMinutes: 60,
      maxItems: 100,
      maxPages: 10,
      timeZone: "Asia/Tokyo",
      feedURL: "weblist://id",
      itemCount: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      nextCheckAt: null,
      consecutiveFailures: 0,
      createdAt: "",
      updatedAt: "",
      deletedAt: null,
    }
    const patch = webListPatch(initialWebListValues(source))
    for (const [key, value] of Object.entries(patch))
      expect(source[key as keyof WebListSource]).toEqual(value)
  })
})

describe("metadata path lines", () => {
  it("keeps only complete label=path lines", () => {
    const values = {
      ...initialWebListValues(),
      format: "json" as const,
      metadataPaths: "文号=filenumbername\nbroken line\n=path\nlabel=\n 来源 = source.name ",
      titlePath: "title",
      urlPath: "url",
    }
    expect(webListInput(values).json?.metadataPaths).toEqual({
      文号: "filenumbername",
      来源: "source.name",
    })
  })
})
