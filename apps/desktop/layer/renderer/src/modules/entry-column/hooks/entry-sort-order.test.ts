import { describe, expect, test } from "vitest"

import { getEffectiveRouteEntrySortOrder, isTimelineEntrySortScope } from "./entry-sort-order"

describe("desktop entry sort scope", () => {
  test.each(["feed-1", "folder-news", "feed-1,feed-2", "list-list-1"])(
    "allows oldest-first unread sorting for %s timeline sources",
    (feedId) => {
      expect(
        getEffectiveRouteEntrySortOrder({
          sortOrder: "asc",
          unreadOnly: true,
          feedId,
        }),
      ).toBe("asc")
    },
  )

  test.each([
    ["all-content", { feedId: "feed-1", unreadOnly: false }],
    ["inbox", { inboxId: "inbox-1", unreadOnly: true }],
    ["collection", { feedId: "collections", isCollection: true, unreadOnly: true }],
    ["preview", { feedId: "feed-1", isPreview: true, unreadOnly: true }],
  ] as const)("forces %s sources to newest-first", (_name, scope) => {
    expect(
      getEffectiveRouteEntrySortOrder({
        sortOrder: "asc",
        ...scope,
      }),
    ).toBe("desc")
  })

  test("shows the control only for non-preview timeline scopes", () => {
    expect(isTimelineEntrySortScope({ feedId: "list-list-1" })).toBe(true)
    expect(isTimelineEntrySortScope({ inboxId: "inbox-1" })).toBe(false)
    expect(isTimelineEntrySortScope({ isCollection: true })).toBe(false)
    expect(isTimelineEntrySortScope({ feedId: "feed-1", isPreview: true })).toBe(false)
  })
})
