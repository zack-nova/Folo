import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"

import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import { createCapabilityNotImplementedContract } from "@follow/compat-contracts"
import capabilityManifest from "@follow/compat-contracts/capabilities" with { type: "json" }
import { readabilityFromHTML } from "@follow-app/readability"
import { fromNodeHeaders } from "better-auth/node"
import Fastify from "fastify"
import { join } from "pathe"

import type { AppAuth } from "./auth"
import { MemoryDataStore } from "./data/memory-store"
import type {
  DataStore,
  EntryRecord,
  FeedRecord,
  ListPatch,
  ListRecord,
  ListSubscriptionRecord,
  SettingsTab,
  SubscriptionPatch,
  SubscriptionRecord,
} from "./data/types"
import type { FeedFetcher } from "./feeds/importer"
import { FeedImporter } from "./feeds/importer"
import { exportOpml, parseOpml } from "./opml"

export interface BuildServerOptions {
  allowPublicRegistration?: boolean
  auth: AppAuth
  clientOrigins: string[]
  dataStore?: DataStore
  feedFetcher?: FeedFetcher
  readabilityFetcher?: FeedFetcher
  logger?: boolean
  serverURL?: string
  uploadsDirectory?: string
}

type AuthSession = NonNullable<Awaited<ReturnType<AppAuth["api"]["getSession"]>>>

const apiProfile = (user: AuthSession["user"]) => ({
  id: user.id,
  name: user.name,
  image: user.image ?? null,
  emailVerified: user.emailVerified,
  handle: user.handle ?? null,
  bio: user.bio ?? null,
  website: user.website ?? null,
  socialLinks: user.socialLinks ?? null,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
})

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

const apiList = (list: ListRecord) => ({
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

const apiListSubscription = (subscription: ListSubscriptionRecord, list: ListRecord) => ({
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

const avatarType = (buffer: Buffer): { extension: string; mimeType: string } | null => {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: "png", mimeType: "image/png" }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", mimeType: "image/jpeg" }
  }
  const header = buffer.subarray(0, 6).toString("ascii")
  if (header === "GIF87a" || header === "GIF89a") {
    return { extension: "gif", mimeType: "image/gif" }
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: "webp", mimeType: "image/webp" }
  }
  return null
}

const avatarMimeTypes = {
  gif: "image/gif",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const

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
  "organization.core",
  "profiles.core",
  "reads.core",
  "settings_and_status.core",
  "subscriptions.core",
  "subscriptions.opml",
])

export const buildServer = async ({
  allowPublicRegistration = false,
  auth,
  clientOrigins,
  dataStore = new MemoryDataStore(),
  feedFetcher,
  readabilityFetcher = feedFetcher,
  logger = false,
  serverURL = "http://localhost:3000",
  uploadsDirectory = "./data/uploads",
}: BuildServerOptions) => {
  const server = Fastify({ logger })
  const importer = feedFetcher ? new FeedImporter(dataStore, feedFetcher) : null
  const pendingReadability = new Map<string, Promise<string | null>>()
  let registrationTail = Promise.resolve()

  const acquireRegistrationLock = async () => {
    const previous = registrationTail
    let release = () => {}
    registrationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    return release
  }

  if (!allowPublicRegistration && !(await dataStore.getOwnerUserId())) {
    const context = await auth.$context
    const existingUsers = await context.adapter.findMany<{ id: string }>({
      limit: 1,
      model: "user",
      select: ["id"],
      sortBy: { direction: "asc", field: "createdAt" },
    })
    const existingUser = existingUsers.at(0)
    if (existingUser) await dataStore.claimOwner(existingUser.id)
  }

  const authenticatedSession = async (headers: Parameters<typeof fromNodeHeaders>[0]) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) })
    if (!session || allowPublicRegistration) return session
    const ownerUserId = await dataStore.claimOwner(session.user.id)
    return ownerUserId === session.user.id ? session : null
  }

  const authenticatedUserId = async (headers: Parameters<typeof fromNodeHeaders>[0]) =>
    (await authenticatedSession(headers))?.user.id ?? null

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
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    origin: clientOrigins,
  })
  await server.register(multipart, {
    limits: { fields: 1, fileSize: 1024 * 1024, files: 1, parts: 2 },
  })
  server.addContentTypeParser(
    ["application/octet-stream", "application/xml", "text/x-opml"],
    { bodyLimit: 512 * 1024, parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  )

  server.get("/health", async () => ({ status: "ok" }))

  server.get("/profiles", async (request, reply) => {
    const session = await authenticatedSession(request.headers)
    if (!session) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const query = request.query as Record<string, unknown>
    const matchesId = query.id === undefined || query.id === session.user.id
    const matchesHandle = query.handle === undefined || query.handle === session.user.handle
    if (!matchesId || !matchesHandle) {
      return reply.status(404).send({ code: "profile_not_found", message: "Profile not found" })
    }
    return { code: 0, data: apiProfile(session.user) }
  })

  server.post("/profiles/batch", async (request, reply) => {
    const session = await authenticatedSession(request.headers)
    if (!session) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === "string")
      : []
    return {
      code: 0,
      data: ids.includes(session.user.id) ? { [session.user.id]: apiProfile(session.user) } : {},
    }
  })

  server.post("/upload/avatar", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    try {
      const file = await request.file({ limits: { fileSize: 1024 * 1024 } })
      if (!file) {
        return reply.status(400).send({ code: "invalid_avatar", message: "An image is required" })
      }
      const buffer = await file.toBuffer()
      const type = avatarType(buffer)
      if (!type) {
        return reply
          .status(415)
          .send({ code: "unsupported_avatar", message: "Use a PNG, JPEG, GIF, or WebP image" })
      }

      const filename = `${createHash("sha256").update(buffer).digest("hex")}.${type.extension}`
      const directory = join(uploadsDirectory, "avatars")
      await mkdir(directory, { recursive: true })
      try {
        await writeFile(join(directory, filename), buffer, { flag: "wx" })
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      }
      return { code: 0, url: `${serverURL.replace(/\/$/, "")}/uploads/avatars/${filename}` }
    } catch (error) {
      if (error instanceof Error && error.name === "RequestFileTooLargeError") {
        return reply.status(413).send({ code: "avatar_too_large", message: "Avatar exceeds 1 MiB" })
      }
      throw error
    }
  })

  server.get<{ Params: { filename: string } }>(
    "/uploads/avatars/:filename",
    async (request, reply) => {
      const match = /^[a-f0-9]{64}\.(gif|jpg|png|webp)$/.exec(request.params.filename)
      if (!match) return reply.status(404).send({ code: "avatar_not_found" })
      try {
        const buffer = await readFile(join(uploadsDirectory, "avatars", request.params.filename))
        return reply
          .header("cache-control", "public, max-age=31536000, immutable")
          .type(avatarMimeTypes[match[1] as keyof typeof avatarMimeTypes])
          .send(buffer)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return reply.status(404).send({ code: "avatar_not_found" })
        }
        throw error
      }
    },
  )

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
      MAX_LISTS: 1_000,
      MAX_SUBSCRIPTIONS: 10_000,
      MAX_TRIAL_USER_FEED_SUBSCRIPTION: 10_000,
      MAX_TRIAL_USER_LIST_SUBSCRIPTION: 1_000,
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

    const listSubscriptionRecords = await dataStore.listListSubscriptions(
      userId,
      numberFromUnknown(query.view),
    )
    const listData = await Promise.all(
      listSubscriptionRecords.map(async (subscription) => {
        const list = await dataStore.getList(userId, subscription.listId)
        return list ? apiListSubscription(subscription, list) : null
      }),
    )

    return {
      code: 0,
      data: [...data.filter((item) => item !== null), ...listData.filter((item) => item !== null)],
    }
  })

  server.patch("/subscriptions", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
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
      const subscription =
        typeof body.feedId === "string"
          ? await subscriptionForFeed(userId, body.feedId)
          : typeof body.listId === "string"
            ? (await dataStore.listListSubscriptions(userId)).find(
                (item) => item.listId === body.listId,
              )
            : null
      if (!subscription) {
        return reply
          .status(404)
          .send({ code: "subscription_not_found", message: "Subscription not found" })
      }
      return { code: 0, data: subscription }
    }
    const subscription =
      typeof body.feedId === "string"
        ? await dataStore.updateSubscription(userId, body.feedId, patch)
        : typeof body.listId === "string"
          ? await dataStore.updateListSubscription(userId, body.listId, patch)
          : null
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
    if (typeof body.listId === "string") {
      await dataStore.deleteListSubscription(userId, body.listId)
    }
    return { code: 0, data: null }
  })

  server.post("/subscriptions/parse-opml", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    if (!Buffer.isBuffer(request.body)) {
      return reply
        .status(400)
        .send({ code: "invalid_opml", message: "An OPML document is required" })
    }

    try {
      const subscriptions = parseOpml(request.body.toString("utf8"))
      const currentCount = (await dataStore.listSubscriptions(userId)).length
      return {
        code: 0,
        data: {
          remaining: Math.max(0, 10_000 - currentCount),
          subscriptions: subscriptions.map((subscription) => ({ ...subscription, userId })),
        },
      }
    } catch (error) {
      return reply.status(400).send({
        code: "invalid_opml",
        message: error instanceof Error ? error.message : "The OPML document is invalid",
      })
    }
  })

  server.post("/subscriptions/import", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    if (!importer) {
      return reply
        .status(503)
        .send({ code: "feed_fetcher_unavailable", message: "Feed fetcher is not configured" })
    }

    const file = await request.file({ limits: { fileSize: 512 * 1024 } })
    if (!file) {
      return reply.status(400).send({ code: "invalid_opml", message: "An OPML file is required" })
    }

    try {
      const subscriptions = parseOpml((await file.toBuffer()).toString("utf8"))
      const itemsField = file.fields.items
      const selectedItems =
        itemsField && !Array.isArray(itemsField) && itemsField.type === "field"
          ? JSON.parse(String(itemsField.value))
          : null
      const selectedURLs = Array.isArray(selectedItems)
        ? new Set(selectedItems.filter((item): item is string => typeof item === "string"))
        : null
      const selected = selectedURLs
        ? subscriptions.filter((subscription) => selectedURLs.has(subscription.url))
        : subscriptions

      const existingSubscriptions = await dataStore.listSubscriptions(userId)
      const existingByURL = new Map<string, FeedRecord>()
      await Promise.all(
        existingSubscriptions.map(async (subscription) => {
          const feed = await dataStore.getFeed(subscription.feedId)
          if (feed) existingByURL.set(feed.url, feed)
        }),
      )

      const successfulItems: Array<{ id: string; title: string | null; url: string }> = []
      const conflictItems: Array<{ id: string; title: string | null; url: string }> = []
      const parsedErrorItems: Array<{ title: string | null; url: string }> = []
      for (const subscription of selected) {
        const existing = existingByURL.get(subscription.url)
        if (existing) {
          conflictItems.push({ id: existing.id, title: subscription.title, url: subscription.url })
          continue
        }
        try {
          const imported = await importer.subscribe(userId, subscription)
          successfulItems.push({
            id: imported.feed.id,
            title: subscription.title,
            url: subscription.url,
          })
          existingByURL.set(subscription.url, imported.feed)
        } catch {
          parsedErrorItems.push({ title: subscription.title, url: subscription.url })
        }
      }

      return { code: 0, data: { conflictItems, parsedErrorItems, successfulItems } }
    } catch (error) {
      return reply.status(400).send({
        code: "invalid_opml",
        message: error instanceof Error ? error.message : "The OPML document is invalid",
      })
    }
  })

  server.get("/subscriptions/export", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const query = request.query as Record<string, unknown>
    let subscriptions = await dataStore.listSubscriptions(userId)
    if (typeof query.categoryId === "string") {
      subscriptions = subscriptions.filter(
        (subscription) => subscription.category === query.categoryId,
      )
    }
    if (typeof query.listId === "string") {
      const list = await dataStore.getList(userId, query.listId)
      const feedIds = new Set(list?.feedIds ?? [])
      subscriptions = subscriptions.filter((subscription) => feedIds.has(subscription.feedId))
    }

    const exportable = (
      await Promise.all(
        subscriptions.map(async (subscription) => {
          const feed = await dataStore.getFeed(subscription.feedId)
          return feed
            ? {
                category: subscription.category,
                siteUrl: feed.siteUrl,
                title: subscription.title ?? feed.title,
                url: feed.url,
                view: subscription.view,
              }
            : null
        }),
      )
    ).filter((subscription) => subscription !== null)

    if (query.format === "json") {
      return {
        content: JSON.stringify(exportable, null, 2),
        contentType: "application/json; charset=utf-8",
        filename: "folo-subscriptions.json",
      }
    }
    return {
      content: exportOpml(exportable),
      contentType: "text/x-opml; charset=utf-8",
      filename: "folo-subscriptions.opml",
    }
  })

  server.patch("/categories", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const feedIds = Array.isArray(body.feedIdList)
      ? body.feedIdList.filter((id): id is string => typeof id === "string")
      : []
    if (typeof body.category !== "string" || feedIds.length === 0) {
      return reply
        .status(400)
        .send({ code: "invalid_request", message: "feedIdList and category are required" })
    }
    await Promise.all(
      feedIds.map((feedId) =>
        dataStore.updateSubscription(userId, feedId, { category: body.category as string }),
      ),
    )
    return { code: 0, data: null }
  })

  server.delete("/categories", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const feedIds = Array.isArray(body.feedIdList)
      ? body.feedIdList.filter((id): id is string => typeof id === "string")
      : []
    if (body.deleteSubscriptions === true) {
      await dataStore.deleteSubscriptions(userId, feedIds)
    } else {
      await Promise.all(
        feedIds.map((feedId) => dataStore.updateSubscription(userId, feedId, { category: null })),
      )
    }
    return { code: 0, data: null }
  })

  server.post("/lists", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.title !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "title is required" })
    }
    const now = new Date()
    const view = numberFromUnknown(body.view) ?? 0
    const list: ListRecord = {
      id: `list_${randomUUID().replaceAll("-", "")}`,
      feedIds: [],
      title: body.title,
      description: typeof body.description === "string" ? body.description : null,
      image: typeof body.image === "string" ? body.image : null,
      view,
      fee: numberFromUnknown(body.fee) ?? 0,
      ownerUserId: userId,
      createdAt: now,
      updatedAt: now,
    }
    await dataStore.createList(list, {
      userId,
      listId: list.id,
      view,
      category: null,
      title: null,
      isPrivate: false,
      hideFromTimeline: null,
      createdAt: now,
    })
    return { code: 0, data: apiList(list) }
  })

  server.get("/lists/list", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const records = await dataStore.listLists(userId)
    const data = await Promise.all(
      records.map(async (list) => ({
        ...apiList(list),
        feeds: (await Promise.all(list.feedIds.map((feedId) => dataStore.getFeed(feedId))))
          .filter((feed): feed is FeedRecord => feed !== null)
          .map(apiFeed),
        subscriptionCount: 1,
        purchaseAmount: 0,
      })),
    )
    return { code: 0, data }
  })

  server.get("/lists", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const query = request.query as Record<string, unknown>
    if (typeof query.listId !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "listId is required" })
    }
    const list = await dataStore.getList(userId, query.listId)
    if (!list) return reply.status(404).send({ code: "list_not_found", message: "List not found" })
    const feedRecords = (
      await Promise.all(list.feedIds.map((feedId) => dataStore.getFeed(feedId)))
    ).filter((feed): feed is FeedRecord => feed !== null)
    const rows = await dataStore.listEntries({
      userId,
      feedIdList: list.feedIds,
      limit: 20,
    })
    const subscription = (await dataStore.listListSubscriptions(userId)).find(
      (item) => item.listId === list.id,
    )
    return {
      code: 0,
      data: {
        list: { ...apiList(list), feeds: feedRecords.map(apiFeed) },
        ...(subscription ? { subscription } : {}),
        subscriptionCount: subscription ? 1 : 0,
        readCount: rows.filter((row) => row.read).length,
        feedCount: feedRecords.length,
        entries: await Promise.all(
          rows.map(async ({ entry }) => ({
            ...apiEntry(entry),
            feedId: entry.feedId,
            content: entry.content,
            feeds: apiFeed((await dataStore.getFeed(entry.feedId))!),
          })),
        ),
      },
    }
  })

  server.patch("/lists", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.listId !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "listId is required" })
    }
    const patch: ListPatch = {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(body.description === null || typeof body.description === "string"
        ? { description: body.description }
        : {}),
      ...(body.image === null || typeof body.image === "string" ? { image: body.image } : {}),
      ...(typeof body.view === "number" ? { view: body.view } : {}),
      ...(typeof body.fee === "number" ? { fee: body.fee } : {}),
    }
    const updated = await dataStore.updateList(userId, body.listId, patch)
    if (!updated)
      return reply.status(404).send({ code: "list_not_found", message: "List not found" })
    return { code: 0, data: null }
  })

  server.delete("/lists", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.listId !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "listId is required" })
    }
    await dataStore.deleteList(userId, body.listId)
    return { code: 0, data: null }
  })

  server.post("/lists/feeds", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.listId !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "listId is required" })
    }
    const requestedFeedIds = [
      ...(typeof body.feedId === "string" ? [body.feedId] : []),
      ...(Array.isArray(body.feedIds)
        ? body.feedIds.filter((id): id is string => typeof id === "string")
        : []),
    ]
    const allowedIds = new Set(
      (await dataStore.listSubscriptions(userId)).map((item) => item.feedId),
    )
    const feedIds = requestedFeedIds.filter((feedId) => allowedIds.has(feedId))
    const list = await dataStore.getList(userId, body.listId)
    if (!list) return reply.status(404).send({ code: "list_not_found", message: "List not found" })
    await dataStore.setListFeeds(userId, list.id, [...list.feedIds, ...feedIds])
    const addedFeeds = (
      await Promise.all(feedIds.map((feedId) => dataStore.getFeed(feedId)))
    ).filter((feed): feed is FeedRecord => feed !== null)
    return { code: 0, data: addedFeeds.map(apiFeed) }
  })

  server.delete("/lists/feeds", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.listId !== "string" || typeof body.feedId !== "string") {
      return reply
        .status(400)
        .send({ code: "invalid_request", message: "listId and feedId are required" })
    }
    const list = await dataStore.getList(userId, body.listId)
    if (!list) return reply.status(404).send({ code: "list_not_found", message: "List not found" })
    await dataStore.setListFeeds(
      userId,
      list.id,
      list.feedIds.filter((feedId) => feedId !== body.feedId),
    )
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
    if (!entry) return { code: 0, data: null }
    const cached = await dataStore.getReadability(userId, entry.id)
    if (cached) return { code: 0, data: { content: cached.content } }
    if (!entry.url || !readabilityFetcher) {
      return { code: 0, data: entry.content ? { content: entry.content } : null }
    }

    let extraction = pendingReadability.get(entry.id)
    if (!extraction) {
      extraction = (async () => {
        try {
          const fetched = await readabilityFetcher.fetch(entry.url!)
          if (
            fetched.contentType &&
            !fetched.contentType.includes("text/html") &&
            !fetched.contentType.includes("application/xhtml+xml")
          ) {
            return entry.content
          }
          const content = readabilityFromHTML(fetched.url, fetched.body)?.content ?? entry.content
          if (content) await dataStore.setReadability(userId, entry.id, content)
          return content
        } catch {
          return entry.content
        } finally {
          pendingReadability.delete(entry.id)
        }
      })()
      pendingReadability.set(entry.id, extraction)
    }
    const content = await extraction
    return { code: 0, data: content ? { content } : null }
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
      const isRegistration =
        request.method === "POST" && url.pathname === "/better-auth/sign-up/email"
      const releaseRegistration =
        isRegistration && !allowPublicRegistration ? await acquireRegistrationLock() : null

      try {
        if (isRegistration && !allowPublicRegistration && (await dataStore.getOwnerUserId())) {
          return reply.status(403).send({
            code: "registration_closed",
            message: "This self-hosted instance already has an owner",
          })
        }
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

        const responseBody = await response.text()
        if (isRegistration && response.ok && !allowPublicRegistration) {
          const parsed = JSON.parse(responseBody) as { user?: { id?: unknown } }
          if (typeof parsed.user?.id === "string") {
            const ownerUserId = await dataStore.claimOwner(parsed.user.id)
            if (ownerUserId !== parsed.user.id) {
              return reply.status(403).send({
                code: "registration_closed",
                message: "This self-hosted instance already has an owner",
              })
            }
          }
        }

        response.headers.forEach((value, name) => {
          if (name === "content-length" || name === "set-cookie") return
          reply.header(name, value)
        })

        const cookies = response.headers.getSetCookie()
        if (cookies.length > 0) reply.header("set-cookie", cookies)

        return reply.status(response.status).send(responseBody)
      } finally {
        releaseRegistration?.()
      }
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
