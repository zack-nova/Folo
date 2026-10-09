import { getStableRouterNavigate } from "@follow/components/atoms/route.js"

import {
  checkAdvertisedCapability,
  getCapabilityManifest,
  useAdvertisedCapability,
} from "~/atoms/capabilities"
import { getFeature, useFeature } from "~/hooks/biz/useFeature"

const TASK_REPORTS_CAPABILITY = "ai.task_reports"

/**
 * The server keeps AI chat off but serves scheduled task reports (ADR-0036). The AI page then only
 * lists and shows reports: no composer, no new chats, no AI panel.
 */
export const useAIReportsOnly = (): boolean => {
  const aiEnabled = useFeature("ai")
  const taskReports = useAdvertisedCapability(TASK_REPORTS_CAPABILITY)
  return !aiEnabled && taskReports
}

export const getAIReportsOnly = (): boolean =>
  !getFeature("ai") && checkAdvertisedCapability(getCapabilityManifest(), TASK_REPORTS_CAPABILITY)

/** Opens a report on the AI page, where the AI panel would otherwise show it. */
export const openTaskReportPage = (chatId: string) => {
  getStableRouterNavigate()?.(`/ai?chat=${encodeURIComponent(chatId)}`)
}
