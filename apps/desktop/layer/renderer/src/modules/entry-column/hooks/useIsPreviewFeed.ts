import { getSubscriptionByFeedId } from "@follow/store/subscription/getter"
import { isBizId } from "@follow/utils/utils"
import { useMemo } from "react"

import { useRouteParamsSelector } from "~/hooks/biz/useRouteParams"

export const getIsPreviewFeed = ({ feedId, listId }: { feedId?: string; listId?: string }) => {
  if (listId) {
    return !getSubscriptionByFeedId(listId)
  }
  return !!feedId && isBizId(feedId) && !getSubscriptionByFeedId(feedId)
}

export const useIsPreviewFeed = () => {
  const listId = useRouteParamsSelector((s) => s.listId)
  const feedId = useRouteParamsSelector((s) => s.feedId)

  return useMemo(() => getIsPreviewFeed({ feedId, listId }), [listId, feedId])
}
