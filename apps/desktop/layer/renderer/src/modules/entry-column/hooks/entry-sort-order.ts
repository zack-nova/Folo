import type { EntrySortOrder } from "@follow/store/entry/types"
import { getEffectiveEntrySortOrder, isTimelineEntriesSource } from "@follow/store/entry/utils"

interface EntrySortScope {
  feedId?: string
  inboxId?: string
  isCollection?: boolean
  isPreview?: boolean
}

export const isTimelineEntrySortScope = ({
  feedId,
  inboxId,
  isCollection,
  isPreview,
}: EntrySortScope) => !isPreview && isTimelineEntriesSource({ feedId, inboxId, isCollection })

export const getEffectiveRouteEntrySortOrder = ({
  sortOrder,
  unreadOnly,
  ...scope
}: EntrySortScope & {
  sortOrder?: EntrySortOrder
  unreadOnly: boolean
}) =>
  getEffectiveEntrySortOrder({
    sortOrder,
    unreadOnly,
    isTimelineSource: isTimelineEntrySortScope(scope),
  })
