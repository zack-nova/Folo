import { isBizId } from "@follow/utils/utils"

import type { ReEvaluationScope } from "./types"

export const resolveReEvaluationScope = ({
  entryIds,
  feedId,
  folderFeedIds,
  isAllFeeds,
  view,
}: {
  entryIds: string[]
  feedId: string | undefined
  folderFeedIds: string[] | undefined
  isAllFeeds: boolean
  view: number
}): ReEvaluationScope => {
  if (isBizId(feedId)) return { feed_id: feedId, view }
  if (folderFeedIds?.length) return { feed_ids: folderFeedIds, view }
  if (isAllFeeds) return { view }
  return { entry_ids: entryIds }
}
