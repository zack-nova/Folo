export interface FeedRecord {
  id: string
  url: string
  title: string | null
  description: string | null
  siteUrl: string | null
  image: string | null
  ownerUserId: string | null
  errorAt: Date | null
  errorMessage: string | null
  etag: string | null
  lastModified: string | null
  fetchedAt: Date
}

export interface EntryRecord {
  id: string
  feedId: string
  guid: string
  title: string | null
  description: string | null
  content: string | null
  url: string | null
  author: string | null
  authorUrl: string | null
  authorAvatar: string | null
  language: string | null
  categories: string[] | null
  attachments: Array<{
    url: string
    title?: string
    duration_in_seconds?: number | string
    mime_type?: string
    size_in_bytes?: number
  }> | null
  media: Array<{
    url: string
    type: "photo" | "video"
    preview_image_url?: string
    width?: number
    height?: number
  }> | null
  extra: {
    links?: Array<{ url: string; type: string; content_html?: string }>
    title_keyword?: string
  } | null
  insertedAt: Date
  publishedAt: Date
}

export interface SubscriptionRecord {
  userId: string
  feedId: string
  view: number
  category: string | null
  title: string | null
  isPrivate: boolean
  hideFromTimeline: boolean | null
  createdAt: Date
}

export type SubscriptionPatch = Partial<
  Pick<SubscriptionRecord, "category" | "hideFromTimeline" | "isPrivate" | "title" | "view">
>

export interface EntryListFilter {
  userId: string
  view?: number
  feedId?: string
  feedIdList?: string[]
  read?: boolean
  isCollection?: boolean
  publishedAfter?: Date
  publishedBefore?: Date
  limit: number
}

export interface MarkAllReadFilter {
  view?: number
  feedId?: string
  feedIdList?: string[]
}

export type SettingsTab = "ai" | "appearance" | "general" | "integration"
export interface SettingsRecord {
  payload: Record<string, unknown>
  updatedAt: Date
}

export interface DataStore {
  saveFeed(feed: FeedRecord, entries: EntryRecord[]): Promise<void>
  createSubscription(subscription: SubscriptionRecord): Promise<void>
  updateSubscription(
    userId: string,
    feedId: string,
    patch: SubscriptionPatch,
  ): Promise<SubscriptionRecord | null>
  deleteSubscriptions(userId: string, feedIds: string[]): Promise<void>
  listSubscriptions(userId: string, view?: number): Promise<SubscriptionRecord[]>
  listEntries(filter: EntryListFilter): Promise<
    Array<{
      entry: EntryRecord
      subscription: SubscriptionRecord
      read: boolean
      collectionCreatedAt: Date | null
    }>
  >
  getFeed(id: string): Promise<FeedRecord | null>
  getFeedByUrl(url: string): Promise<FeedRecord | null>
  getEntry(userId: string, id: string): Promise<EntryRecord | null>
  getUnreadCounts(userId: string, view?: number): Promise<Record<string, number>>
  setEntriesRead(userId: string, entryIds: string[], read: boolean): Promise<void>
  markAllAsRead(userId: string, filter: MarkAllReadFilter): Promise<Record<string, number>>
  isEntryCollected(userId: string, entryId: string): Promise<boolean>
  setEntryCollected(userId: string, entryId: string, collected: boolean): Promise<void>
  listSubscribedFeeds(): Promise<FeedRecord[]>
  getSettings(userId: string): Promise<Partial<Record<SettingsTab, SettingsRecord>>>
  setSettings(userId: string, tab: SettingsTab, payload: Record<string, unknown>): Promise<void>
}
