import { describe, expect, it } from "vitest"

import { parseRssHubSource } from "."

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
