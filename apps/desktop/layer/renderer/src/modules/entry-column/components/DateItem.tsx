import { FeedViewType } from "@follow/constants"
import { stopPropagation } from "@follow/utils/dom"
import { clsx, cn } from "@follow/utils/utils"
import type { FC, PropsWithChildren } from "react"
import { memo, useMemo, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { useDebounceCallback } from "usehooks-ts"

import { SafeFragment } from "~/components/common/Fragment"
import { RelativeDay } from "~/components/ui/datetime"
import { useEntriesUnreadCount } from "~/hooks/biz/useAsRead"
import { useShowEntryDetailsColumn } from "~/hooks/biz/useShowEntryDetailsColumn"

import { readableContentMaxWidth } from "../styles"

interface DateItemInnerProps {
  date: Date
  className?: string
  Wrapper?: FC<PropsWithChildren>
  isSticky?: boolean
  /** Entry ids in this date group, used for the count / unread summary */
  entryIds: string[]
}

type DateItemProps = Pick<DateItemInnerProps, "isSticky" | "entryIds"> & {
  view: FeedViewType
  date: string
  className?: string
}
const useParseDate = (date: string) =>
  useMemo(() => {
    const dateObj = new Date(date)
    return {
      dateObj,
      startOfDay: new Date(dateObj.setHours(0, 0, 0, 0)).getTime(),
      endOfDay: new Date(dateObj.setHours(23, 59, 59, 999)).getTime(),
    }
  }, [date])

const dateItemclassName = tw`relative flex items-center text-sm lg:text-base gap-1 px-3 font-bold text-text h-10`
export const DateItem = memo(({ date, view, isSticky, entryIds }: DateItemProps) => {
  const showEntryDetailsColumn = useShowEntryDetailsColumn()

  if (view === FeedViewType.SocialMedia || !showEntryDetailsColumn) {
    return (
      <SocialMediaDateItem
        date={date}
        className={dateItemclassName}
        isSticky={isSticky}
        entryIds={entryIds}
      />
    )
  }
  return (
    <UniversalDateItem
      date={date}
      className={dateItemclassName}
      isSticky={isSticky}
      entryIds={entryIds}
    />
  )
})
const UniversalDateItem = ({
  date,
  className,
  isSticky,
  entryIds,
}: Omit<DateItemProps, "view">) => {
  const { dateObj } = useParseDate(date)

  return (
    <DateItemInner
      className={clsx(className, readableContentMaxWidth)}
      date={dateObj}
      isSticky={isSticky}
      entryIds={entryIds}
    />
  )
}

const useWeekday = (date: Date) => {
  const { i18n } = useTranslation()
  const { language } = i18n

  return useMemo(() => {
    try {
      return new Intl.DateTimeFormat(language, { weekday: "short" }).format(date)
    } catch {
      return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date)
    }
  }, [date, language])
}

const DateGroupSummary: FC<{ entryIds: string[] }> = ({ entryIds }) => {
  const { t } = useTranslation()
  const unreadCount = useEntriesUnreadCount(entryIds)

  if (entryIds.length === 0) return null

  return (
    <span className="ml-auto shrink-0 text-xs font-normal tabular-nums text-text-tertiary">
      {t("entry_column.date_group_count", { count: entryIds.length })}
      {unreadCount > 0 && (
        <>
          <span className="mx-1">·</span>
          {t("entry_column.date_group_unread", { count: unreadCount })}
        </>
      )}
    </span>
  )
}

const DateItemInner: FC<DateItemInnerProps> = ({
  date,
  className,
  Wrapper,
  isSticky,
  entryIds,
}) => {
  const [confirmMark, setConfirmMark] = useState(false)
  const removeConfirm = useDebounceCallback(
    () => {
      setConfirmMark(false)
    },
    1000,
    {
      leading: false,
    },
  )

  const W = Wrapper ?? SafeFragment
  const weekday = useWeekday(date)

  const RelativeElement = (
    <span key="b" className="inline-flex items-center gap-1">
      <span className="text-sm font-bold">
        <RelativeDay date={date} />
      </span>
      <span className="text-sm font-normal text-text-secondary">· {weekday}</span>
    </span>
  )
  return (
    <div
      className={cn(
        className,
        "border-b border-transparent bg-background pl-7",
        isSticky && "border-fill-tertiary bg-background/85 backdrop-blur",
      )}
      onClick={stopPropagation}
      onMouseEnter={removeConfirm.cancel}
      onMouseLeave={removeConfirm}
    >
      <W>
        {confirmMark ? (
          <div className="animate-mask-in" key="a">
            <Trans
              i18nKey="mark_all_read_button.confirm_mark_all"
              components={{
                which: <>{RelativeElement}</>,
              }}
            />
          </div>
        ) : (
          RelativeElement
        )}
        <DateGroupSummary entryIds={entryIds} />
      </W>
    </div>
  )
}
const SocialMediaDateItem = ({
  date,
  className,
  isSticky,
  entryIds,
}: {
  date: string
  className?: string
  isSticky?: boolean
  entryIds: string[]
}) => {
  const { dateObj } = useParseDate(date)

  return (
    <DateItemInner
      Wrapper={({ children }) => (
        <div
          className={cn(
            "m-auto flex w-full max-w-[645px] select-none gap-3 pl-2 text-base lg:text-lg",
          )}
        >
          {children}
        </div>
      )}
      className={className}
      date={dateObj}
      isSticky={isSticky}
      entryIds={entryIds}
    />
  )
}
