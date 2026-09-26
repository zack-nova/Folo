import { inboxSyncService } from "@follow/store/inbox/store"
import { useCallback } from "react"

import { CopyButton } from "~/components/ui/button/CopyButton"

export const InboxSecret = ({ id }: { id: string }) => {
  const getSecret = useCallback(() => inboxSyncService.getInboxSecret(id), [id])

  return (
    <div className="group relative flex w-fit items-center gap-2 font-mono">
      <span className="shrink-0">****</span>
      <CopyButton
        value={getSecret}
        className="p-1 lg:absolute lg:-right-6 lg:opacity-0 lg:group-hover:opacity-100 [&_i]:size-3"
      />
    </div>
  )
}
