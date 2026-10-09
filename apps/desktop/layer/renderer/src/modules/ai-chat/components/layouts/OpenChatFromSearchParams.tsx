import { useEffect } from "react"
import { useSearchParams } from "react-router"
import { useEventCallback } from "usehooks-ts"

import { followApi } from "~/lib/api-client"

import { useChatSessionHandlers } from "./shared"

/**
 * Opens the session named by `?chat=` (a task report picked in settings) the same way picking it
 * in the report list does, then drops the parameter so it does not reopen.
 */
export const OpenChatFromSearchParams = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const chatId = searchParams.get("chat")
  const { handleSessionSelect } = useChatSessionHandlers({})
  const open = useEventCallback(async (id: string) => {
    try {
      const { data } = await followApi.aiChatSessions.get({ chatId: id })
      if (data) await handleSessionSelect(data)
    } catch (error) {
      console.error("Failed to open the chat session from the URL", error)
    } finally {
      setSearchParams({}, { replace: true })
    }
  })

  useEffect(() => {
    if (chatId) void open(chatId)
  }, [chatId, open])

  return null
}
