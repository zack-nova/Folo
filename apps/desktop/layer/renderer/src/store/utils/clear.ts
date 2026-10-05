import { deleteDB } from "@follow/database/db"
import { resetStore } from "@follow/store/reset"
import { useSubscriptionStore } from "@follow/store/subscription/store"
import { getStorageNS } from "@follow/utils/ns"

import { QUERY_PERSIST_KEY } from "~/constants"

import { clearImageDimensionsDb } from "../image/db"

export const clearLocalPersistStoreData = async () => {
  await Promise.all([deleteDB(), clearImageDimensionsDb()])
}

const storedUserId = getStorageNS("user_id")
export const clearDataIfLoginOtherAccount = (newUserId: string) => {
  const oldUserId = localStorage.getItem(storedUserId)
  localStorage.setItem(storedUserId, newUserId)
  if (oldUserId !== newUserId) {
    return clearLocalPersistStoreData()
  }
}

/**
 * Clears local data that belongs to another account than the signed-in one. Electron clears it
 * from the main process on sign-in, but the web build only reloads after signing in, so without
 * this check the previous account's subscriptions and entries stay on screen for the next one,
 * and its unsent changes would be replayed into the new account.
 *
 * When no owner was recorded yet, the owners of the local subscriptions decide, so an existing
 * cache of the same account is kept. The tables are emptied in place rather than deleting the
 * database, which would block while another tab still holds it open. Returns whether anything
 * was cleared.
 */
export const clearLocalDataOfOtherAccount = async (userId: string): Promise<boolean> => {
  const recordedUserId = localStorage.getItem(storedUserId)
  const belongsToOtherAccount =
    recordedUserId === null
      ? Object.values(useSubscriptionStore.getState().data).some(
          (subscription) => subscription.userId !== userId,
        )
      : recordedUserId !== userId
  localStorage.setItem(storedUserId, userId)
  if (!belongsToOtherAccount) return false

  localStorage.removeItem(QUERY_PERSIST_KEY)
  await resetStore()
  return true
}
