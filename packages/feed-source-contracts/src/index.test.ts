import { describe, expect, it } from "vitest"

import {
  behaviorFeedURL,
  pageChangeFeedURL,
  parseBehaviorSource,
  parsePageChangeSource,
  parseRssHubSource,
  parseWebListSource,
  webListFeedURL,
} from "."

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

describe("web list source contract", () => {
  const sourceId = "5f0c1d7e-2a8b-4c3d-9e1f-0a2b3c4d5e6f"

  it("uses a stable UUID-only logical URL", () => {
    expect(webListFeedURL(sourceId.toUpperCase())).toBe(`weblist://${sourceId}`)
    expect(parseWebListSource(`weblist://${sourceId}`)).toEqual({
      logicalURL: `weblist://${sourceId}`,
      sourceId,
    })
  })

  it("rejects targets, queries and other schemes", () => {
    expect(() => parseWebListSource(`weblist://${sourceId}/list`)).toThrow("only a source ID")
    expect(() => parseWebListSource(`weblist://${sourceId}?url=https://example.com`)).toThrow(
      "query or fragment",
    )
    expect(() => parseWebListSource(`pagechange://${sourceId}`)).toThrow("weblist://")
    expect(() => parseWebListSource("weblist://not-a-uuid")).toThrow("UUID")
  })
})

describe("behavior source contract", () => {
  const sourceId = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

  it("uses a stable UUID-only logical URL", () => {
    expect(behaviorFeedURL(sourceId.toUpperCase())).toBe(`behavior://${sourceId}`)
    expect(parseBehaviorSource(`behavior://${sourceId}`)).toEqual({
      logicalURL: `behavior://${sourceId}`,
      sourceId,
    })
  })

  it("rejects account details, queries and other schemes", () => {
    expect(() => parseBehaviorSource(`behavior://${sourceId}/12345678`)).toThrow("only a source ID")
    expect(() => parseBehaviorSource(`behavior://${sourceId}?uid=1`)).toThrow("query or fragment")
    expect(() => parseBehaviorSource(`weblist://${sourceId}`)).toThrow("behavior://")
    expect(() => parseBehaviorSource("behavior://not-a-uuid")).toThrow("UUID")
  })
})
