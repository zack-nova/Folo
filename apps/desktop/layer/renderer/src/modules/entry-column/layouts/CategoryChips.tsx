import type { FeedViewType } from "@follow/constants"
import { useCategoriesByView, useFolderFeedsByFeedId } from "@follow/store/subscription/hooks"
import { useUnreadByIds } from "@follow/store/unread/hooks"
import { cn } from "@follow/utils/utils"
import type { FC, ReactNode } from "react"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"

import { useNavigateEntry } from "~/hooks/biz/useNavigateEntry"

import { categoryChipsStyles } from "./styles"

const chipClassName = tw`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] leading-none transition-colors duration-150`

const ChipButton: FC<{
  active: boolean
  onClick: () => void
  children: ReactNode
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    className={cn(
      chipClassName,
      active
        ? "bg-text text-background"
        : "bg-fill-tertiary text-text-secondary hover:bg-fill-secondary",
    )}
    onClick={onClick}
  >
    {children}
  </button>
)

const CategoryChip: FC<{
  category: string
  view: FeedViewType
  active: boolean
  onSelect: (category: string) => void
}> = ({ category, view, active, onSelect }) => {
  const feedIds = useFolderFeedsByFeedId({ feedId: category, view })
  const unread = useUnreadByIds(feedIds)

  return (
    <ChipButton active={active} onClick={() => onSelect(category)}>
      <span>{category}</span>
      {unread > 0 && (
        <span
          className={cn(
            "text-[11px] tabular-nums",
            active ? "text-background/70" : "text-text-tertiary",
          )}
        >
          {unread}
        </span>
      )}
    </ChipButton>
  )
}

export const useSortedCategoriesByView = (view: FeedViewType) => {
  const categories = useCategoriesByView(view)
  return useMemo(
    () => Array.from(categories).sort((a, b) => a.localeCompare(b, "zh-CN")),
    [categories],
  )
}

export const CategoryChips: FC<{
  view: FeedViewType
  categories: string[]
  activeCategory?: string
}> = ({ view, categories, activeCategory }) => {
  const { t } = useTranslation()
  const navigate = useNavigateEntry()

  const navigateToAll = () => {
    navigate({ entryId: null, feedId: null, view })
  }

  const handleSelect = (category: string) => {
    if (category === activeCategory) {
      navigateToAll()
      return
    }
    navigate({ entryId: null, folderName: category, view })
  }

  return (
    <div
      className="-mx-3 mt-1.5 flex items-center gap-2 overflow-x-auto px-3 scrollbar-none"
      style={categoryChipsStyles.scroller}
      onClick={(e) => e.stopPropagation()}
    >
      <ChipButton active={!activeCategory} onClick={navigateToAll}>
        {t("words.all")}
      </ChipButton>
      {categories.map((category) => (
        <CategoryChip
          key={category}
          category={category}
          view={view}
          active={category === activeCategory}
          onSelect={handleSelect}
        />
      ))}
    </div>
  )
}
