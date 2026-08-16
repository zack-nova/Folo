import type {
  DataStore,
  EntryListFilter,
  EntryRecord,
  FeedRecord,
  MarkAllReadFilter,
  SettingsRecord,
  SettingsTab,
  SubscriptionPatch,
  SubscriptionRecord,
} from "./types"

const subscriptionKey = (userId: string, feedId: string) => `${userId}:${feedId}`
const readKey = (userId: string, entryId: string) => `${userId}:${entryId}`
const collectionKey = (userId: string, entryId: string) => `${userId}:${entryId}`

export class MemoryDataStore implements DataStore {
  private readonly collections = new Map<string, Date>()
  private readonly entries = new Map<string, EntryRecord>()
  private readonly feeds = new Map<string, FeedRecord>()
  private readonly reads = new Set<string>()
  private readonly settings = new Map<string, SettingsRecord>()
  private readonly subscriptions = new Map<string, SubscriptionRecord>()

  async saveFeed(feed: FeedRecord, entries: EntryRecord[]): Promise<void> {
    this.feeds.set(feed.id, structuredClone(feed))
    for (const entry of entries) this.entries.set(entry.id, structuredClone(entry))
  }

  async createSubscription(subscription: SubscriptionRecord): Promise<void> {
    this.subscriptions.set(
      subscriptionKey(subscription.userId, subscription.feedId),
      structuredClone(subscription),
    )
  }

  async updateSubscription(
    userId: string,
    feedId: string,
    patch: SubscriptionPatch,
  ): Promise<SubscriptionRecord | null> {
    const key = subscriptionKey(userId, feedId)
    const current = this.subscriptions.get(key)
    if (!current) return null
    const updated = { ...current, ...structuredClone(patch) }
    this.subscriptions.set(key, updated)
    return structuredClone(updated)
  }

  async deleteSubscriptions(userId: string, feedIds: string[]): Promise<void> {
    for (const feedId of new Set(feedIds)) {
      this.subscriptions.delete(subscriptionKey(userId, feedId))
    }
  }

  async listSubscriptions(userId: string, view?: number): Promise<SubscriptionRecord[]> {
    return [...this.subscriptions.values()]
      .filter(
        (subscription) =>
          subscription.userId === userId && (view === undefined || subscription.view === view),
      )
      .map((subscription) => structuredClone(subscription))
  }

  async listEntries({
    userId,
    view,
    feedId,
    feedIdList,
    read,
    isCollection,
    publishedAfter,
    publishedBefore,
    limit,
  }: EntryListFilter): Promise<
    Array<{
      entry: EntryRecord
      subscription: SubscriptionRecord
      read: boolean
      collectionCreatedAt: Date | null
    }>
  > {
    const allowedFeeds = new Map(
      [...this.subscriptions.values()]
        .filter(
          (subscription) =>
            subscription.userId === userId &&
            (view === undefined || subscription.view === view) &&
            (feedId === undefined || subscription.feedId === feedId) &&
            (feedIdList === undefined || feedIdList.includes(subscription.feedId)),
        )
        .map((subscription) => [subscription.feedId, subscription]),
    )

    return [...this.entries.values()]
      .filter((entry) => allowedFeeds.has(entry.feedId))
      .filter((entry) => read === undefined || this.reads.has(readKey(userId, entry.id)) === read)
      .filter(
        (entry) => isCollection !== true || this.collections.has(collectionKey(userId, entry.id)),
      )
      .filter(
        (entry) =>
          publishedAfter === undefined || entry.publishedAt.getTime() > publishedAfter.getTime(),
      )
      .filter(
        (entry) =>
          publishedBefore === undefined || entry.publishedAt.getTime() < publishedBefore.getTime(),
      )
      .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime())
      .slice(0, limit)
      .map((entry) => ({
        entry: structuredClone(entry),
        subscription: structuredClone(allowedFeeds.get(entry.feedId)!),
        read: this.reads.has(readKey(userId, entry.id)),
        collectionCreatedAt:
          structuredClone(this.collections.get(collectionKey(userId, entry.id))) ?? null,
      }))
  }

  async getFeed(id: string): Promise<FeedRecord | null> {
    const feed = this.feeds.get(id)
    return feed ? structuredClone(feed) : null
  }

  async getFeedByUrl(url: string): Promise<FeedRecord | null> {
    const feed = [...this.feeds.values()].find((item) => item.url === url)
    return feed ? structuredClone(feed) : null
  }

  async getEntry(userId: string, id: string): Promise<EntryRecord | null> {
    const entry = this.entries.get(id)
    if (!entry || !this.subscriptions.has(subscriptionKey(userId, entry.feedId))) return null
    return structuredClone(entry)
  }

  async getUnreadCounts(userId: string, view?: number): Promise<Record<string, number>> {
    const subscriptions = await this.listSubscriptions(userId, view)
    return Object.fromEntries(
      subscriptions.map((subscription) => [
        subscription.feedId,
        [...this.entries.values()].filter(
          (entry) =>
            entry.feedId === subscription.feedId && !this.reads.has(readKey(userId, entry.id)),
        ).length,
      ]),
    )
  }

  async setEntriesRead(userId: string, entryIds: string[], read: boolean): Promise<void> {
    for (const entryId of new Set(entryIds)) {
      const entry = await this.getEntry(userId, entryId)
      if (!entry) continue
      const key = readKey(userId, entryId)
      if (read) this.reads.add(key)
      else this.reads.delete(key)
    }
  }

  async markAllAsRead(userId: string, filter: MarkAllReadFilter): Promise<Record<string, number>> {
    const subscriptions = (await this.listSubscriptions(userId, filter.view)).filter(
      (subscription) =>
        (filter.feedId === undefined || subscription.feedId === filter.feedId) &&
        (filter.feedIdList === undefined || filter.feedIdList.includes(subscription.feedId)),
    )
    const marked: Record<string, number> = {}

    for (const subscription of subscriptions) {
      let count = 0
      for (const entry of this.entries.values()) {
        const key = readKey(userId, entry.id)
        if (entry.feedId !== subscription.feedId || this.reads.has(key)) continue
        this.reads.add(key)
        count += 1
      }
      marked[subscription.feedId] = count
    }

    return marked
  }

  async isEntryCollected(userId: string, entryId: string): Promise<boolean> {
    return this.collections.has(collectionKey(userId, entryId))
  }

  async setEntryCollected(userId: string, entryId: string, collected: boolean): Promise<void> {
    if (!(await this.getEntry(userId, entryId))) return
    const key = collectionKey(userId, entryId)
    if (collected) this.collections.set(key, new Date())
    else this.collections.delete(key)
  }

  async listSubscribedFeeds(): Promise<FeedRecord[]> {
    const feedIds = new Set(
      [...this.subscriptions.values()].map((subscription) => subscription.feedId),
    )
    return [...feedIds]
      .map((feedId) => this.feeds.get(feedId))
      .filter((feed): feed is FeedRecord => feed !== undefined)
      .map((feed) => structuredClone(feed))
  }

  async getSettings(userId: string): Promise<Partial<Record<SettingsTab, SettingsRecord>>> {
    const result: Partial<Record<SettingsTab, SettingsRecord>> = {}
    for (const tab of ["ai", "appearance", "general", "integration"] as const) {
      const record = this.settings.get(`${userId}:${tab}`)
      if (record) result[tab] = structuredClone(record)
    }
    return result
  }

  async setSettings(
    userId: string,
    tab: SettingsTab,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.settings.set(`${userId}:${tab}`, {
      payload: structuredClone(payload),
      updatedAt: new Date(),
    })
  }
}
