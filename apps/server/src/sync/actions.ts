import { apiListSubscription, apiSubscription } from "../api-shapes"
import type {
  FeedRecord,
  ListPatch,
  ListRecord,
  ListSubscriptionRecord,
  SettingsTab,
  SubscriptionPatch,
  SubscriptionRecord,
  SyncActionInput,
} from "../data/types"

// Builders for the change log that the client sync engine replays
// (packages/internal/store/src/sync/sync-engine.ts). Both data stores use them, so every
// action carries the same shape whichever store recorded it.

/** Log rows older than this are deleted; a cursor below them must take a fresh snapshot. */
export const SYNC_ACTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

/**
 * "New entries" hints are by far the most numerous rows and only save a client a refetch, so
 * they go sooner and do not force a snapshot: the client recounts unread entries hourly anyway.
 */
export const SYNC_HINT_RETENTION_MS = 3 * 24 * 60 * 60 * 1_000

/** Read flips are split into rows of at most this many entry ids. */
export const TIMELINE_ENTRY_IDS_PER_ACTION = 500

/** Settings tabs that hold credentials are logged without their payload. */
const credentialSettingsTabs: ReadonlySet<SettingsTab> = new Set(["ai"])

const definedFields = (patch: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))

export const subscriptionInserted = (
  subscription: SubscriptionRecord,
  feed: FeedRecord,
): SyncActionInput => ({
  userId: subscription.userId,
  model: "subscription",
  modelId: subscription.feedId,
  action: "I",
  data: apiSubscription(subscription, feed),
})

export const subscriptionUpdated = (
  userId: string,
  feedId: string,
  patch: SubscriptionPatch,
): SyncActionInput => ({
  userId,
  model: "subscription",
  modelId: feedId,
  action: "U",
  data: definedFields(patch),
})

export const subscriptionDeleted = (userId: string, feedId: string): SyncActionInput => ({
  userId,
  model: "subscription",
  modelId: feedId,
  action: "D",
  data: null,
})

export const listSubscriptionInserted = (
  subscription: ListSubscriptionRecord,
  list: ListRecord,
): SyncActionInput => ({
  userId: subscription.userId,
  model: "list_subscription",
  modelId: subscription.listId,
  action: "I",
  data: apiListSubscription(subscription, list),
})

export const listSubscriptionUpdated = (
  userId: string,
  listId: string,
  patch: SubscriptionPatch,
): SyncActionInput => ({
  userId,
  model: "list_subscription",
  modelId: listId,
  action: "U",
  data: definedFields(patch),
})

export const listSubscriptionDeleted = (userId: string, listId: string): SyncActionInput => ({
  userId,
  model: "list_subscription",
  modelId: listId,
  action: "D",
  data: null,
})

export const listUpdated = (
  userId: string,
  listId: string,
  patch: ListPatch | { feedIds: string[] },
): SyncActionInput => ({
  userId,
  model: "list",
  modelId: listId,
  action: "U",
  data: definedFields(patch),
})

export const listDeleted = (userId: string, listId: string): SyncActionInput => ({
  userId,
  model: "list",
  modelId: listId,
  action: "D",
  data: null,
})

export const collectionInserted = (
  userId: string,
  collection: { entryId: string; feedId: string; view: number; createdAt: Date },
): SyncActionInput => ({
  userId,
  model: "collection",
  modelId: collection.entryId,
  action: "I",
  data: {
    entryId: collection.entryId,
    feedId: collection.feedId,
    view: collection.view,
    createdAt: collection.createdAt.toISOString(),
  },
})

export const collectionDeleted = (userId: string, entryId: string): SyncActionInput => ({
  userId,
  model: "collection",
  modelId: entryId,
  action: "D",
  data: null,
})

/**
 * Entries whose read state really flipped, as `{ entryId, feedId }` pairs. The counts per feed
 * let clients move their unread counters without a recount.
 */
export const timelineReadFlipped = (
  userId: string,
  read: boolean,
  flipped: ReadonlyArray<{ entryId: string; feedId: string }>,
): SyncActionInput[] => {
  const actions: SyncActionInput[] = []
  for (let start = 0; start < flipped.length; start += TIMELINE_ENTRY_IDS_PER_ACTION) {
    const chunk = flipped.slice(start, start + TIMELINE_ENTRY_IDS_PER_ACTION)
    const feeds: Record<string, number> = {}
    for (const { feedId } of chunk) feeds[feedId] = (feeds[feedId] ?? 0) + 1
    actions.push({
      userId,
      model: "timeline",
      modelId: null,
      action: "U",
      data: { entryIds: chunk.map(({ entryId }) => entryId), read, isInbox: false, feeds },
    })
  }
  return actions
}

/** New entries of one feed reached a subscriber; all of them arrive unread. */
export const timelineEntriesArrived = (
  userId: string,
  feedId: string,
  inserted: ReadonlyArray<{ publishedAt: Date }>,
  listIds: readonly string[],
): SyncActionInput => ({
  userId,
  model: "timeline",
  modelId: feedId,
  action: "N",
  data: {
    feedId,
    count: inserted.length,
    unread: inserted.length,
    latestPublishedAt: new Date(
      Math.max(...inserted.map((entry) => entry.publishedAt.getTime())),
    ).toISOString(),
    from: ["feed", ...listIds],
  },
})

export const actionRulesUpdated = (
  userId: string,
  rules: Array<Record<string, unknown>>,
): SyncActionInput => ({
  userId,
  model: "action",
  modelId: null,
  action: "U",
  data: { rules },
})

export const settingsUpdated = (
  userId: string,
  tab: SettingsTab,
  payload: Record<string, unknown>,
  updatedAt: Date,
): SyncActionInput => ({
  userId,
  model: "setting",
  modelId: tab,
  action: "U",
  data: credentialSettingsTabs.has(tab)
    ? { updatedAt: updatedAt.toISOString() }
    : { payload, updatedAt: updatedAt.toISOString() },
})
