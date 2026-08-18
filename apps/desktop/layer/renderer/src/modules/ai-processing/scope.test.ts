import { describe, expect, it } from "vitest"

import { resolveReEvaluationScope } from "./scope"

describe("re-evaluation scope", () => {
  it("uses the exact feed for a regular feed route", () => {
    expect(
      resolveReEvaluationScope({
        entryIds: ["entry-1"],
        feedId: "feed_0123456789abcdef01234567",
        folderFeedIds: undefined,
        isAllFeeds: false,
        view: 0,
      }),
    ).toEqual({ feed_id: "feed_0123456789abcdef01234567", view: 0 })
  })

  it("uses all feeds in the selected folder", () => {
    expect(
      resolveReEvaluationScope({
        entryIds: ["entry-1"],
        feedId: "folder-technology",
        folderFeedIds: ["feed-1", "feed-2"],
        isAllFeeds: false,
        view: 1,
      }),
    ).toEqual({ feed_ids: ["feed-1", "feed-2"], view: 1 })
  })

  it("uses the view only for the all-feeds timeline", () => {
    expect(
      resolveReEvaluationScope({
        entryIds: ["entry-1"],
        feedId: "pending",
        folderFeedIds: undefined,
        isAllFeeds: true,
        view: 2,
      }),
    ).toEqual({ view: 2 })
  })

  it("limits special lists and inboxes to loaded entries", () => {
    expect(
      resolveReEvaluationScope({
        entryIds: ["entry-1", "entry-2"],
        feedId: "list-special",
        folderFeedIds: undefined,
        isAllFeeds: false,
        view: 0,
      }),
    ).toEqual({ entry_ids: ["entry-1", "entry-2"] })
  })
})
