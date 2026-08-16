import cors from "@fastify/cors"
import { createCapabilityNotImplementedContract } from "@follow/compat-contracts"
import capabilityManifest from "@follow/compat-contracts/capabilities" with { type: "json" }
import { fromNodeHeaders } from "better-auth/node"
import Fastify from "fastify"

import type { AppAuth } from "./auth"
import { MemoryDataStore } from "./data/memory-store"
import type {
  DataStore,
  EntryRecord,
  FeedRecord,
  SettingsTab,
  SubscriptionPatch,
  SubscriptionRecord,
} from "./data/types"
import type { FeedFetcher } from "./feeds/importer"
import { FeedImporter } from "./feeds/importer"

export interface BuildServerOptions {
  auth: AppAuth
  clientOrigins: string[]
  dataStore?: DataStore
  feedFetcher?: FeedFetcher
  logger?: boolean
}

const bodyForAuthRequest = (body: unknown): BodyInit | undefined => {
  if (body === undefined || body === null) return undefined
  if (typeof body === "string") return body
  return JSON.stringify(body)
}

const apiFeed = (feed: FeedRecord) => ({
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

const apiSubscription = (subscription: SubscriptionRecord, feed: FeedRecord) => ({
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

const apiEntry = (entry: EntryRecord) => ({
  id: entry.id,
  title: entry.title,
  url: entry.url,
  description: entry.description,
  summary: null,
  guid: entry.guid,
  author: entry.author,
  authorUrl: entry.authorUrl,
  authorAvatar: entry.authorAvatar,
  insertedAt: entry.insertedAt.toISOString(),
  publishedAt: entry.publishedAt.toISOString(),
  media: entry.media,
  categories: entry.categories,
  attachments: entry.attachments,
  extra: entry.extra,
  language: entry.language,
})

const numberFromUnknown = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const dateFromUnknown = (value: unknown): Date | undefined => {
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) {
    return undefined
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

const limitFromUnknown = (value: unknown, defaultValue: number, maximum: number): number =>
  Math.min(Math.max(Math.trunc(numberFromUnknown(value) ?? defaultValue), 1), maximum)

const settingsTabs = ["general", "appearance", "integration", "ai"] as const
const isSettingsTab = (value: string): value is SettingsTab =>
  settingsTabs.includes(value as SettingsTab)
const implementedCapabilities = new Set([
  "auth.account_management",
  "auth.credentials",
  "collections.core",
  "discovery.standard_feed",
  "entries.core",
  "feeds.core",
  "reads.core",
  "settings_and_status.core",
  "subscriptions.core",
])

export const buildServer = async ({
  auth,
  clientOrigins,
  dataStore = new MemoryDataStore(),
  feedFetcher,
  logger = false,
}: BuildServerOptions) => {
  const server = Fastify({ logger })
  const importer = feedFetcher ? new FeedImporter(dataStore, feedFetcher) : null

  const authenticatedUserId = async (headers: Parameters<typeof fromNodeHeaders>[0]) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) })
    return session?.user.id ?? null
  }

  const subscriptionForFeed = async (userId: string, feedId: string) =>
    (await dataStore.listSubscriptions(userId)).find(
      (subscription) => subscription.feedId === feedId,
    ) ?? null

  const feedAnalytics = (feedId: string, entries: EntryRecord[], subscriptionCount: number) => ({
    feedId,
    updatesPerWeek: entries.length,
    subscriptionCount,
    independentSubscriptionCount: subscriptionCount,
    activeSubscriptionCount: subscriptionCount,
    latestEntryPublishedAt: entries.at(0)?.publishedAt.toISOString() ?? null,
    view: null,
    boostPoints: null,
  })

  await server.register(cors, {
    credentials: true,
    origin: clientOrigins,
  })

  server.get("/health", async () => ({ status: "ok" }))

  server.get("/api/extensions/capabilities", async () => {
    const capabilities = capabilityManifest.capabilities
      .filter(
        (capability) =>
          capability.provider === "local" && implementedCapabilities.has(capability.id),
      )
      .map((capability) => ({ id: capability.id, provider: "local" as const }))
    const enabled = new Set(capabilities.map((capability) => capability.id))

    return {
      code: 0,
      data: {
        compatibilityVersion: capabilityManifest.compatibilityVersion,
        stage: 1,
        capabilities,
        unavailable: capabilityManifest.capabilities
          .map((capability) => capability.id)
          .filter((id) => !enabled.has(id)),
      },
    }
  })

  server.get("/status/configs", async () => ({
    code: 0,
    data: {
      AI_CHAT_ENABLED: false,
      AI_SHORTCUTS: [],
      ANNOUNCEMENT: "",
      IMPORTING_TITLE: "",
      INVITATION_ENABLED: false,
      INVITATION_INTERVAL_DAYS: 0,
      IS_RSS3_TESTNET: false,
      MAX_ACTIONS: 0,
      MAX_INBOXES: 0,
      MAX_LISTS: 0,
      MAX_SUBSCRIPTIONS: 10_000,
      MAX_TRIAL_USER_FEED_SUBSCRIPTION: 10_000,
      MAX_TRIAL_USER_LIST_SUBSCRIPTION: 0,
      MAX_WEBHOOKS_PER_ACTION: 0,
      PAYMENT_ENABLED: false,
      PAYMENT_PLAN_LIST: [],
      PRODUCT_HUNT_VOTE_URL: "",
      REFERRAL_ENABLED: false,
      REFERRAL_REQUIRED_INVITATIONS: 0,
      REFERRAL_RULE_LINK: "",
    },
  }))

  server.get("/settings", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const query = request.query as Record<string, unknown>
    const requestedTabs =
      typeof query.tab === "string" ? query.tab.split(",").filter(isSettingsTab) : [...settingsTabs]
    const records = await dataStore.getSettings(userId)
    const settings = Object.fromEntries(
      requestedTabs.map((tab) => [tab, records[tab]?.payload ?? {}]),
    )
    const updated = Object.fromEntries(
      requestedTabs.map((tab) => [tab, (records[tab]?.updatedAt ?? new Date(0)).toISOString()]),
    )
    return { code: 0, settings, updated }
  })

  server.patch<{ Params: { tab: string } }>("/settings/:tab", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    if (!isSettingsTab(request.params.tab)) {
      return reply.status(400).send({ code: "invalid_request", message: "Unknown settings tab" })
    }
    const payload = (request.body ?? {}) as Record<string, unknown>
    await dataStore.setSettings(userId, request.params.tab, payload)
    return { code: 0, data: null }
  })

  server.post("/subscriptions", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    if (!importer) {
      return reply
        .status(503)
        .send({ code: "feed_fetcher_unavailable", message: "Feed fetcher is not configured" })
    }

    const body = request.body as Record<string, unknown> | null
    if (!body || typeof body.url !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "url is required" })
    }

    const imported = await importer.subscribe(userId, {
      url: body.url,
      view: numberFromUnknown(body.view),
      category: typeof body.category === "string" ? body.category : null,
      isPrivate: typeof body.isPrivate === "boolean" ? body.isPrivate : false,
      title: typeof body.title === "string" ? body.title : null,
    })

    return {
      code: 0,
      feed: apiFeed(imported.feed),
      list: null,
      unread: { [imported.feed.id]: imported.entries.length },
    }
  })

  server.post("/discover", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    if (!importer) {
      return reply
        .status(503)
        .send({ code: "feed_fetcher_unavailable", message: "Feed fetcher is not configured" })
    }

    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.keyword !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "keyword is required" })
    }
    if (body.target === "lists") return { code: 0, data: [] }

    try {
      const preview = await importer.preview(body.keyword)
      return {
        code: 0,
        data: [
          {
            feed: apiFeed(preview.feed),
            entries: preview.entries.map((entry) => ({
              ...apiEntry(entry),
              content: entry.content,
              feedId: entry.feedId,
            })),
            subscriptionCount: 0,
            updatesPerWeek: 0,
          },
        ],
      }
    } catch {
      return { code: 0, data: [] }
    }
  })

  server.get("/subscriptions", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }

    const query = request.query as Record<string, unknown>
    const subscriptions = await dataStore.listSubscriptions(userId, numberFromUnknown(query.view))
    const data = await Promise.all(
      subscriptions.map(async (subscription) => {
        const feed = await dataStore.getFeed(subscription.feedId)
        return feed ? apiSubscription(subscription, feed) : null
      }),
    )

    return { code: 0, data: data.filter((item) => item !== null) }
  })

  server.patch("/subscriptions", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.feedId !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "feedId is required" })
    }
    const patch: SubscriptionPatch = {
      ...(typeof body.view === "number" ? { view: body.view } : {}),
      ...(body.category === null || typeof body.category === "string"
        ? { category: body.category }
        : {}),
      ...(body.title === null || typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.isPrivate === "boolean" ? { isPrivate: body.isPrivate } : {}),
      ...(body.hideFromTimeline === null || typeof body.hideFromTimeline === "boolean"
        ? { hideFromTimeline: body.hideFromTimeline }
        : {}),
    }
    if (Object.keys(patch).length === 0) {
      const subscription = await subscriptionForFeed(userId, body.feedId)
      if (!subscription) {
        return reply
          .status(404)
          .send({ code: "subscription_not_found", message: "Subscription not found" })
      }
      return { code: 0, data: subscription }
    }
    const subscription = await dataStore.updateSubscription(userId, body.feedId, patch)
    if (!subscription) {
      return reply
        .status(404)
        .send({ code: "subscription_not_found", message: "Subscription not found" })
    }
    return { code: 0, data: subscription }
  })

  server.patch("/subscriptions/batch", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const feedIds = Array.isArray(body.feedIds)
      ? body.feedIds.filter((id): id is string => typeof id === "string")
      : []
    const patch: SubscriptionPatch = {
      ...(typeof body.view === "number" ? { view: body.view } : {}),
      ...(body.category === null || typeof body.category === "string"
        ? { category: body.category }
        : {}),
      ...(body.title === null || typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.isPrivate === "boolean" ? { isPrivate: body.isPrivate } : {}),
    }
    if (Object.keys(patch).length === 0) return { code: 0, data: null }
    await Promise.all(feedIds.map((feedId) => dataStore.updateSubscription(userId, feedId, patch)))
    return { code: 0, data: null }
  })

  server.delete("/subscriptions", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const feedIds = new Set(
      Array.isArray(body.feedIdList)
        ? body.feedIdList.filter((id): id is string => typeof id === "string")
        : [],
    )
    if (typeof body.feedId === "string") feedIds.add(body.feedId)
    if (typeof body.url === "string") {
      const feed = await dataStore.getFeedByUrl(body.url)
      if (feed) feedIds.add(feed.id)
    }
    await dataStore.deleteSubscriptions(userId, [...feedIds])
    return { code: 0, data: null }
  })

  server.get("/feeds", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const query = request.query as Record<string, unknown>
    const entriesLimit = limitFromUnknown(query.entriesLimit, 3, 20)
    let feed: FeedRecord | null = null
    let entryRecords: EntryRecord[] = []

    if (typeof query.url === "string") {
      if (!importer) {
        return reply
          .status(503)
          .send({ code: "feed_fetcher_unavailable", message: "Feed fetcher is not configured" })
      }
      const preview = await importer.preview(query.url)
      feed = preview.feed
      entryRecords = preview.entries.slice(0, entriesLimit)
    } else if (typeof query.id === "string") {
      const subscription = await subscriptionForFeed(userId, query.id)
      feed = subscription ? await dataStore.getFeed(query.id) : null
      if (feed) {
        entryRecords = (
          await dataStore.listEntries({
            userId,
            feedId: feed.id,
            limit: entriesLimit,
          })
        ).map((row) => row.entry)
      }
    } else {
      return reply.status(400).send({ code: "invalid_request", message: "id or url is required" })
    }

    if (!feed) return reply.status(404).send({ code: "feed_not_found", message: "Feed not found" })
    const subscription = await subscriptionForFeed(userId, feed.id)
    const allEntries = subscription
      ? await dataStore.listEntries({ userId, feedId: feed.id, limit: 100 })
      : []
    const readCount = allEntries.filter((row) => row.read).length
    const analytics = feedAnalytics(feed.id, entryRecords, subscription ? 1 : 0)

    return {
      code: 0,
      data: {
        feed: apiFeed(feed),
        entries: entryRecords.map(apiEntry),
        ...(subscription ? { subscription } : {}),
        readCount,
        subscriptionCount: subscription ? 1 : 0,
        analytics,
      },
    }
  })

  server.get("/feeds/refresh", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    if (!importer) {
      return reply
        .status(503)
        .send({ code: "feed_fetcher_unavailable", message: "Feed fetcher is not configured" })
    }

    const query = request.query as Record<string, unknown>
    if (typeof query.id !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "id is required" })
    }
    const subscription = (await dataStore.listSubscriptions(userId)).find(
      (item) => item.feedId === query.id,
    )
    const feed = subscription ? await dataStore.getFeed(subscription.feedId) : null
    if (!feed) {
      return reply.status(404).send({ code: "feed_not_found", message: "Feed not found" })
    }

    await importer.refresh(feed)
    return { code: 0, data: null }
  })

  server.get("/feeds/reset", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    if (!importer) {
      return reply
        .status(503)
        .send({ code: "feed_fetcher_unavailable", message: "Feed fetcher is not configured" })
    }
    const query = request.query as Record<string, unknown>
    const subscription =
      typeof query.id === "string" ? await subscriptionForFeed(userId, query.id) : null
    const feed = subscription ? await dataStore.getFeed(subscription.feedId) : null
    if (!feed) {
      return reply.status(404).send({ code: "feed_not_found", message: "Feed not found" })
    }
    await importer.refresh(feed)
    return { code: 0, data: null }
  })

  server.post("/feeds/analytics", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const feedIds = Array.isArray(body.id)
      ? body.id.filter((id): id is string => typeof id === "string")
      : []
    const pairs = await Promise.all(
      feedIds.map(async (feedId) => {
        const subscription = await subscriptionForFeed(userId, feedId)
        if (!subscription) return null
        const rows = await dataStore.listEntries({ userId, feedId, limit: 100 })
        return [
          feedId,
          feedAnalytics(
            feedId,
            rows.map((row) => row.entry),
            1,
          ),
        ] as const
      }),
    )
    return {
      code: 0,
      data: { analytics: Object.fromEntries(pairs.filter((pair) => pair !== null)) },
    }
  })

  server.post("/entries", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }

    const body = (request.body ?? {}) as Record<string, unknown>
    const rows = await dataStore.listEntries({
      userId,
      view: numberFromUnknown(body.view),
      feedId: typeof body.feedId === "string" ? body.feedId : undefined,
      feedIdList: Array.isArray(body.feedIdList)
        ? body.feedIdList.filter((id): id is string => typeof id === "string")
        : undefined,
      read: typeof body.read === "boolean" ? body.read : undefined,
      isCollection: body.isCollection === true,
      publishedAfter: dateFromUnknown(body.publishedAfter),
      publishedBefore: dateFromUnknown(body.publishedBefore),
      limit: limitFromUnknown(body.limit, 20, 100),
    })
    const data = await Promise.all(
      rows.map(async ({ entry, subscription, read, collectionCreatedAt }) => {
        const feed = await dataStore.getFeed(entry.feedId)
        if (!feed) return null
        return {
          read,
          view: subscription.view,
          from: [],
          feeds: apiFeed(feed),
          entries: apiEntry(entry),
          settings: null,
          ...(collectionCreatedAt
            ? { collections: { createdAt: collectionCreatedAt.toISOString() } }
            : {}),
        }
      }),
    )

    return { code: 0, data: data.filter((item) => item !== null) }
  })

  server.get("/entries", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }

    const query = request.query as Record<string, unknown>
    if (typeof query.id !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "id is required" })
    }
    const entry = await dataStore.getEntry(userId, query.id)
    if (!entry) return { code: 0, data: null }
    const feed = await dataStore.getFeed(entry.feedId)
    if (!feed) return { code: 0, data: null }

    return {
      code: 0,
      data: {
        feeds: apiFeed(feed),
        entries: { ...apiEntry(entry), content: entry.content },
        settings: null,
      },
    }
  })

  server.post("/entries/preview", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.id !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "id is required" })
    }
    const entry = await dataStore.getEntry(userId, body.id)
    return { code: 0, data: entry ? { ...apiEntry(entry), content: entry.content } : null }
  })

  server.get("/entries/readability", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const query = request.query as Record<string, unknown>
    if (typeof query.id !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "id is required" })
    }
    const entry = await dataStore.getEntry(userId, query.id)
    return { code: 0, data: entry?.content ? { content: entry.content } : null }
  })

  server.post("/entries/stream", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }

    const body = (request.body ?? {}) as Record<string, unknown>
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 30)
      : []
    const entries = await Promise.all(ids.map((id) => dataStore.getEntry(userId, id)))
    const ndjson = entries
      .filter((entry): entry is EntryRecord => entry !== null && entry.content !== null)
      .map((entry) => JSON.stringify({ id: entry.id, content: entry.content }))
      .join("\n")

    return reply.type("application/x-ndjson; charset=utf-8").send(ndjson ? `${ndjson}\n` : "")
  })

  server.get("/reads", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const query = request.query as Record<string, unknown>
    return { code: 0, data: await dataStore.getUnreadCounts(userId, numberFromUnknown(query.view)) }
  })

  server.get("/reads/total-count", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const counts = await dataStore.getUnreadCounts(userId)
    return {
      code: 0,
      data: { count: Object.values(counts).reduce((sum, count) => sum + count, 0) },
    }
  })

  server.post("/reads", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const entryIds = Array.isArray(body.entryIds)
      ? body.entryIds.filter((id): id is string => typeof id === "string")
      : []
    await dataStore.setEntriesRead(userId, entryIds, true)
    return { code: 0, data: null }
  })

  server.delete("/reads", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.entryId !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "entryId is required" })
    }
    await dataStore.setEntriesRead(userId, [body.entryId], false)
    return { code: 0, data: null }
  })

  server.post("/reads/all", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const read = await dataStore.markAllAsRead(userId, {
      view: numberFromUnknown(body.view),
      feedId: typeof body.feedId === "string" ? body.feedId : undefined,
      feedIdList: Array.isArray(body.feedIdList)
        ? body.feedIdList.filter((id): id is string => typeof id === "string")
        : undefined,
    })
    return { code: 0, data: { read } }
  })

  server.get("/collections", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const query = request.query as Record<string, unknown>
    if (typeof query.entryId !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "entryId is required" })
    }
    return { code: 0, data: await dataStore.isEntryCollected(userId, query.entryId) }
  })

  server.post("/collections", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.entryId !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "entryId is required" })
    }
    await dataStore.setEntryCollected(userId, body.entryId, true)
    return { code: 0, data: null }
  })

  server.delete("/collections", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.entryId !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "entryId is required" })
    }
    await dataStore.setEntryCollected(userId, body.entryId, false)
    return { code: 0, data: null }
  })

  server.route({
    method: ["GET", "POST"],
    url: "/better-auth/*",
    async handler(request, reply) {
      const origin = `${request.protocol}://${request.headers.host ?? "localhost"}`
      const url = new URL(request.url, origin)
      const headers = new Headers()

      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue
        headers.set(name, Array.isArray(value) ? value.join(", ") : value)
      }

      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : bodyForAuthRequest(request.body),
        }),
      )

      response.headers.forEach((value, name) => {
        if (name === "content-length" || name === "set-cookie") return
        reply.header(name, value)
      })

      const cookies = response.headers.getSetCookie()
      if (cookies.length > 0) reply.header("set-cookie", cookies)

      return reply.status(response.status).send(await response.text())
    },
  })

  server.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url
    const capability =
      path.startsWith("/wallets") || path.startsWith("/billing")
        ? "billing_and_wallet"
        : path.startsWith("/rsshub") || path.startsWith("/discover/rsshub")
          ? "rsshub.hosted"
          : path.startsWith("/trending")
            ? "discovery.trending"
            : path.startsWith("/mcp")
              ? "integrations.mcp"
              : path.startsWith("/ai")
                ? "ai.chat"
                : "unavailable_route"
    const contract = createCapabilityNotImplementedContract(capability)
    return reply.status(contract.status).send(contract.body)
  })

  await server.ready()
  return server
}
