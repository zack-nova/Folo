import { beforeEach, describe, expect, test, vi } from "vitest"

const { resetStore, subscriptionState } = vi.hoisted(() => ({
  resetStore: vi.fn(async () => {}),
  subscriptionState: { data: {} as Record<string, { userId: string }> },
}))

vi.mock("@follow/database/db", () => ({ deleteDB: vi.fn(async () => {}) }))
vi.mock("@follow/store/reset", () => ({ resetStore }))
vi.mock("@follow/store/subscription/store", () => ({
  useSubscriptionStore: { getState: () => subscriptionState },
}))
vi.mock("../image/db", () => ({ clearImageDimensionsDb: vi.fn(async () => {}) }))

const { QUERY_PERSIST_KEY } = await import("~/constants")
const { getStorageNS } = await import("@follow/utils/ns")
const { clearLocalDataOfOtherAccount } = await import("./clear")

const ownerKey = getStorageNS("user_id")

describe("clearLocalDataOfOtherAccount", () => {
  beforeEach(() => {
    localStorage.clear()
    resetStore.mockClear()
    subscriptionState.data = {}
    localStorage.setItem(QUERY_PERSIST_KEY, "cached queries")
  })

  test("keeps the data of the account that was already signed in", async () => {
    localStorage.setItem(ownerKey, "user-a")

    await expect(clearLocalDataOfOtherAccount("user-a")).resolves.toBe(false)
    expect(resetStore).not.toHaveBeenCalled()
    expect(localStorage.getItem(QUERY_PERSIST_KEY)).toBe("cached queries")
  })

  test("clears the data of the previously signed-in account", async () => {
    localStorage.setItem(ownerKey, "user-a")

    await expect(clearLocalDataOfOtherAccount("user-b")).resolves.toBe(true)
    expect(resetStore).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(QUERY_PERSIST_KEY)).toBeNull()
    expect(localStorage.getItem(ownerKey)).toBe("user-b")
  })

  test("without a recorded owner, keeps a cache whose subscriptions are the user's own", async () => {
    subscriptionState.data = { feed_1: { userId: "user-a" } }

    await expect(clearLocalDataOfOtherAccount("user-a")).resolves.toBe(false)
    expect(resetStore).not.toHaveBeenCalled()
    expect(localStorage.getItem(ownerKey)).toBe("user-a")
  })

  test("without a recorded owner, clears subscriptions that belong to someone else", async () => {
    subscriptionState.data = { feed_1: { userId: "user-a" } }

    await expect(clearLocalDataOfOtherAccount("user-b")).resolves.toBe(true)
    expect(resetStore).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(QUERY_PERSIST_KEY)).toBeNull()
  })
})
