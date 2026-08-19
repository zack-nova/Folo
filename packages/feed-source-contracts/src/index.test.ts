import { describe, expect, it } from "vitest"

import { pageChangeFeedURL, parsePageChangeSource, parseRssHubSource } from "."

describe("RSSHub source contract", () => {
  it("normalizes a logical route without exposing supplier credentials", () => {
    expect(parseRssHubSource("rsshub://github/stars/DIYgod/RSSHub?limit=20")).toEqual({
      logicalURL: "rsshub://github/stars/DIYgod/RSSHub?limit=20",
      routePath: "/github/stars/DIYgod/RSSHub",
      search: "?limit=20",
    })
  })

  it("rejects embedded access keys and non-RSSHub URLs", () => {
    expect(() => parseRssHubSource("rsshub://github/stars/example/repo?key=secret")).toThrow(
      "access keys",
    )
    expect(() => parseRssHubSource("https://rsshub.example.com/github/stars/example/repo")).toThrow(
      "rsshub://",
    )
  })
})

describe("page change source contract", () => {
  const sourceId = "8bd44f7a-84d2-4b0c-b052-3cdacbfc3919"

  it("uses a stable UUID-only logical URL", () => {
    expect(pageChangeFeedURL(sourceId)).toBe(`pagechange://${sourceId}`)
    expect(parsePageChangeSource(`pagechange://${sourceId}`)).toEqual({
      logicalURL: `pagechange://${sourceId}`,
      sourceId,
    })
  })

  it("rejects mutable target details in the logical URL", () => {
    expect(() => parsePageChangeSource(`pagechange://${sourceId}/path`)).toThrow("only a source ID")
    expect(() => parsePageChangeSource(`pagechange://${sourceId}?url=https://example.com`)).toThrow(
      "query or fragment",
    )
  })
})
