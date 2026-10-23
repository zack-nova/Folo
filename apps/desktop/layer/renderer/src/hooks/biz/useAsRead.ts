import { useEntry } from "@follow/store/entry/hooks"
import { useEntryStore } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"
import { useIsLoggedIn } from "@follow/store/user/hooks"
import { useCallback } from "react"

import { useRouteParamsSelector } from "./useRouteParams"

const selector = (state: EntryModel) => state.read
export function useEntryIsRead(entryId?: string) {
  const entryRead = useEntry(entryId, selector)

  const isLoggedIn = useIsLoggedIn()

  return useRouteParamsSelector(
    (params) => {
      if (!isLoggedIn) return true
      if (params.isCollection) {
        return true
      }
      if (entryRead === undefined) return false
      return entryRead
    },
    [entryRead, isLoggedIn],
  )
}

/**
 * Count unread entries among `entryIds`, using the same rules as `useEntryIsRead`.
 */
export function useEntriesUnreadCount(entryIds: string[]) {
  const unreadCount = useEntryStore(
    useCallback(
      (state) => entryIds.reduce((count, id) => (state.data[id]?.read ? count : count + 1), 0),
      [entryIds],
    ),
  )

  const isLoggedIn = useIsLoggedIn()

  return useRouteParamsSelector(
    (params) => {
      if (!isLoggedIn || params.isCollection) return 0
      return unreadCount
    },
    [unreadCount, isLoggedIn],
  )
}
