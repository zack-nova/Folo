import { cn } from "@follow/utils"
import dayjs from "dayjs"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"

import { useAIChatSessionListQuery } from "~/modules/ai-chat-session/query"
import { useAITaskListQuery } from "~/modules/ai-task"

import { EmptyState, isTaskSession, isUnreadSession, useChatSessionHandlers } from "./shared"

/** Every task report, newest first; the start screen of the AI page in reports-only mode. */
export const TaskReportList = () => {
  const { t } = useTranslation("ai")
  const tasks = useAITaskListQuery()
  const sessions = useAIChatSessionListQuery({
    refetchInterval: tasks?.length ? 60 * 1000 : false,
  })
  const reports = useMemo(() => (sessions || []).filter((s) => isTaskSession(s)), [sessions])
  const { handleSessionSelect } = useChatSessionHandlers({ sessions: reports })

  if (reports.length === 0) {
    return (
      <EmptyState
        message={t("chat.task_reports.empty")}
        icon={
          <i className="i-mgc-calendar-time-add-cute-re mb-2 block size-8 text-text-secondary" />
        }
      />
    )
  }

  return (
    <ul className="w-full max-w-xl space-y-1" data-testid="task-report-list">
      {reports.map((report) => {
        const unread = isUnreadSession(report)
        return (
          <li key={report.chatId}>
            <button
              type="button"
              onClick={() => handleSessionSelect(report)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-fill-secondary"
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  unread ? "bg-accent" : "bg-transparent",
                )}
                aria-label={unread ? t("chat.history.unread") : undefined}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  unread ? "font-semibold text-text" : "text-text-secondary",
                )}
              >
                {report.title || t("chat.untitled")}
              </span>
              {/* Plain text: the relative-time component is itself a button. */}
              <time className="shrink-0 text-xs text-text-tertiary" dateTime={report.updatedAt}>
                {dayjs(report.updatedAt).format("MM-DD HH:mm")}
              </time>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
