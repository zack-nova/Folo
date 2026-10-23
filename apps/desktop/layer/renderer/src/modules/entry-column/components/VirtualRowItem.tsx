import { useEntry } from "@follow/store/entry/hooks"
import { useIsListSubscription } from "@follow/store/subscription/hooks"
import { clsx } from "@follow/utils/utils"
import type { FC, Key } from "react"
import { Fragment, memo, useMemo } from "react"

import { useRouteParams } from "~/hooks/biz/useRouteParams"

import { EntryVirtualListItem } from "../item"
import { DateItem } from "./DateItem"

interface VirtualRowItemProps {
  virtualRowKey: Key
  entriesIds: string[]
  virtualRowIndex: number
  view: any
  transform: string
  isStickyItem: boolean
  /** Number of entries in the date group that starts at this row, if any */
  groupEntryCount?: number
  isActiveStickyItem: boolean
  measureElement: (element: Element | null) => void
  currentFeedTitle?: string
}

const EntryHeadDateItem: FC<{
  entryId: string
  groupEntryIds: string[]
  isSticky?: boolean
}> = ({ entryId, groupEntryIds, isSticky }) => {
  const entry = useEntry(entryId, (state) => {
    const { insertedAt, publishedAt } = state

    return { insertedAt, publishedAt }
  })

  const routeParams = useRouteParams()
  const { feedId, view } = routeParams
  const isList = useIsListSubscription(feedId)

  if (!entry) return null
  const date = new Date(isList ? entry.insertedAt : entry.publishedAt).toDateString()

  return <DateItem isSticky={isSticky} date={date} view={view} entryIds={groupEntryIds} />
}

export const VirtualRowItem: FC<VirtualRowItemProps> = memo(
  ({
    virtualRowKey,
    entriesIds,
    virtualRowIndex,
    view,
    transform,
    isStickyItem,
    groupEntryCount,
    isActiveStickyItem,
    measureElement,
    currentFeedTitle,
  }) => {
    const groupEntryIds = useMemo(
      () =>
        isStickyItem
          ? entriesIds.slice(virtualRowIndex, virtualRowIndex + (groupEntryCount ?? 1))
          : [],
      [entriesIds, groupEntryCount, isStickyItem, virtualRowIndex],
    )
    return (
      <Fragment key={virtualRowKey}>
        {isStickyItem && (
          <div
            className={clsx(
              isActiveStickyItem
                ? "sticky top-0 z-[1]"
                : "absolute left-0 top-0 w-full will-change-transform",
            )}
            style={
              !isActiveStickyItem
                ? {
                    transform,
                  }
                : undefined
            }
          >
            <EntryHeadDateItem
              entryId={entriesIds[virtualRowIndex]!}
              groupEntryIds={groupEntryIds}
              isSticky={isActiveStickyItem}
            />
          </div>
        )}

        <EntryVirtualListItem
          currentFeedTitle={currentFeedTitle}
          entryId={entriesIds[virtualRowIndex]!}
          view={view}
          data-index={virtualRowIndex}
          style={useMemo(
            () => ({
              transform,
              paddingTop: isStickyItem ? "2.25rem" : undefined,
            }),
            [transform, isStickyItem],
          )}
          ref={measureElement}
        />
      </Fragment>
    )
  },
)
