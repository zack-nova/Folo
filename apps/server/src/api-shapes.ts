import type {
  FeedRecord,
  ListRecord,
  ListSubscriptionRecord,
  SubscriptionRecord,
} from "./data/types"

// Response shapes of the Folo API that are shared by the HTTP routes and the sync change log,
// whose actions carry models in the same shape as the snapshot endpoints return them.

export const apiFeed = (feed: FeedRecord) => ({
  id: feed.id,
  type: "feed" as const,
  title: feed.title,
  description: feed.description,
  image: feed.image,
  ownerUserId: feed.ownerUserId,
  owner: null,
  url: feed.url,
  siteUrl: feed.siteUrl,
  errorMessage: feed.errorMessage,
  errorAt: feed.errorAt?.toISOString() ?? null,
  tipUsers: null,
})

export const apiSubscription = (subscription: SubscriptionRecord, feed: FeedRecord) => ({
  userId: subscription.userId,
  feedId: subscription.feedId,
  view: subscription.view,
  category: subscription.category,
  title: subscription.title,
  isPrivate: subscription.isPrivate,
  hideFromTimeline: subscription.hideFromTimeline,
  createdAt: subscription.createdAt.toISOString(),
  feeds: apiFeed(feed),
})

export const apiList = (list: ListRecord) => ({
  id: list.id,
  feedIds: list.feedIds,
  title: list.title,
  description: list.description,
  image: list.image,
  view: list.view,
  fee: list.fee,
  language: null,
  ownerUserId: list.ownerUserId,
  createdAt: list.createdAt.toISOString(),
  updatedAt: list.updatedAt.toISOString(),
})

export const apiListSubscription = (subscription: ListSubscriptionRecord, list: ListRecord) => ({
  userId: subscription.userId,
  feedId: "",
  listId: subscription.listId,
  view: subscription.view,
  category: subscription.category,
  title: subscription.title,
  isPrivate: subscription.isPrivate,
  hideFromTimeline: subscription.hideFromTimeline,
  createdAt: subscription.createdAt.toISOString(),
  lists: {
    ...apiList(list),
    owner: {
      id: list.ownerUserId,
      name: null,
      image: null,
      handle: null,
    },
  },
})
