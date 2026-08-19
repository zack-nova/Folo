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

import {
  credentialHint,
  decryptCredential,
  encryptCredential,
  normalizeProviderBaseURL,
} from "./ai/credentials"
import type { AIProvider } from "./ai/provider"
import { OpenAICompatibleProvider } from "./ai/provider"
import type { AppAuth } from "./auth"
import { MemoryDataStore } from "./data/memory-store"
import type {
  DataStore,
  EntryEvaluationRecord,
  EntryRecord,
  FeedRecord,
  ListPatch,
  ListRecord,
  ListSubscriptionRecord,
  MaintenanceCleanupReport,
  ProcessingJobRecord,
  ProcessingTaxonomySnapshotRecord,
  SettingsTab,
  SubscriptionPatch,
  SubscriptionRecord,
} from "./data/types"
import type { FeedFetcher } from "./feeds/importer"
import { FeedImporter } from "./feeds/importer"
import type { refreshSubscribedFeeds } from "./feeds/scheduler"
import { startFeedScheduler } from "./feeds/scheduler"
import { exportOpml, parseOpml } from "./opml"
import {
  contentHash,
  entryContentFingerprint,
  ProcessingError,
  ProcessingService,
} from "./processing/service"

export interface BuildServerOptions {
  aiEncryptionSecret?: string
  aiProvider?: AIProvider
  aiProviderFetch?: typeof globalThis.fetch
  aiProviderConfig?: {
    apiKey: string
    baseUrl: string
    model: string
    timeoutMs?: number
  }
  allowPublicRegistration?: boolean
  auth: AppAuth
  clientOrigins: string[]
  dataStore?: DataStore
  feedFetcher?: FeedFetcher
  feedPollConcurrency?: number
  feedPollIntervalMs?: number
  feedRetryBaseDelayMs?: number
  readabilityFetcher?: FeedFetcher
  logger?: boolean
  processingMaxAttempts?: number
  processingRetryBaseDelayMs?: number
  processingWorkerPollIntervalMs?: number
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

const apiProcessingJob = (job: ProcessingJobRecord) => ({
  id: job.id,
  entry_id: job.entryId,
  purpose: job.purpose,
  processor_name: job.processorName,
  processor_version: job.processorVersion,
  score_formula_version: job.scoreFormulaVersion,
  profile_snapshot_id: job.profileSnapshotId,
  taxonomy_snapshot_id: job.taxonomySnapshotId,
  content_fingerprint: job.contentFingerprint,
  status: job.status,
  priority: job.priority,
  attempt_count: job.attemptCount,
  queued_at: job.queuedAt.toISOString(),
  started_at: job.startedAt?.toISOString() ?? null,
  finished_at: job.finishedAt?.toISOString() ?? null,
  next_retry_at: job.nextRetryAt?.toISOString() ?? null,
  last_error_code: job.lastErrorCode,
  last_error_summary: job.lastErrorSummary,
  force_rerun: job.forceRerun,
  superseded_by_job_id: job.supersededByJobId,
})

const apiProcessingAttempt = (
  attempt: Awaited<ReturnType<DataStore["listProcessingAttempts"]>>[number],
) => ({
  id: attempt.id,
  job_id: attempt.jobId,
  attempt_number: attempt.attemptNumber,
  status: attempt.status,
  started_at: attempt.startedAt.toISOString(),
  finished_at: attempt.finishedAt?.toISOString() ?? null,
  error_summary: attempt.errorSummary,
  execution_metadata: attempt.executionMetadata,
})

const apiEvaluation = (evaluation: EntryEvaluationRecord, configurationOutdated: boolean) => ({
  id: evaluation.id,
  entry_id: evaluation.entryId,
  importance_score: evaluation.importanceScore,
  timeliness_score: evaluation.timelinessScore,
  relevance_score: evaluation.relevanceScore,
  overall_score: evaluation.overallScore,
  recommendation_reason: evaluation.recommendationReason,
  primary_category: evaluation.primaryCategory,
  secondary_category: evaluation.secondaryCategory,
  tags: evaluation.tags,
  processor_type: evaluation.processorType,
  processor_name: evaluation.processorName,
  processor_version: evaluation.processorVersion,
  score_formula_version: evaluation.scoreFormulaVersion,
  profile_snapshot_id: evaluation.profileSnapshotId,
  taxonomy_snapshot_id: evaluation.taxonomySnapshotId,
  content_fingerprint: evaluation.contentFingerprint,
  processed_at: evaluation.processedAt.toISOString(),
  details: evaluation.details,
  configuration_outdated: configurationOutdated,
})

const DEFAULT_FEATURED_HALF_LIFE_DAYS = 7
const FEATURED_SCORE_THRESHOLD = 70

const positiveNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null

const featuredHalfLifeDays = (
  taxonomy: ProcessingTaxonomySnapshotRecord | null,
  primaryCategory: string,
) => {
  if (!taxonomy) return DEFAULT_FEATURED_HALF_LIFE_DAYS
  const defaultHalfLife =
    positiveNumber(taxonomy.content.default_half_life_days) ?? DEFAULT_FEATURED_HALF_LIFE_DAYS
  const categories = Array.isArray(taxonomy.content.categories) ? taxonomy.content.categories : []
  const category = categories.find(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item) && item.name === primaryCategory,
  )
  return (
    positiveNumber(category?.featured_half_life_days) ??
    positiveNumber(category?.half_life_days) ??
    defaultHalfLife
  )
}

const featuredRankingScore = (
  entry: EntryRecord,
  evaluation: EntryEvaluationRecord,
  taxonomy: ProcessingTaxonomySnapshotRecord | null,
  now = new Date(),
) => {
  const latestReliablePublishedAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000)
  const ageBaseline =
    entry.publishedAt <= latestReliablePublishedAt ? entry.publishedAt : entry.insertedAt
  const ageDays = Math.max(0, now.getTime() - ageBaseline.getTime()) / (24 * 60 * 60 * 1_000)
  const halfLifeDays = featuredHalfLifeDays(taxonomy, evaluation.primaryCategory)
  return evaluation.overallScore * 2 ** (-ageDays / halfLifeDays)
}

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
  "actions.entry_processing",
  "ai.entry_processing",
  "ai.provider_configuration",
  "auth.account_management",
  "auth.credentials",
  "collections.core",
  "discovery.standard_feed",
  "entries.core",
  "entries.ai_fusion",
  "entries.evaluation_processing",
  "feeds.core",
  "organization.core",
  "operations.stability",
  "profiles.core",
  "reads.core",
  "settings_and_status.core",
  "subscriptions.core",
  "subscriptions.acquisition_diagnostics",
  "subscriptions.opml",
])

export const buildServer = async ({
  aiEncryptionSecret,
  aiProvider,
  aiProviderFetch,
  aiProviderConfig,
  allowPublicRegistration = false,
  auth,
  clientOrigins,
  dataStore = new MemoryDataStore(),
  feedFetcher,
  feedPollConcurrency,
  feedPollIntervalMs,
  feedRetryBaseDelayMs,
  readabilityFetcher = feedFetcher,
  logger = false,
  processingMaxAttempts,
  processingRetryBaseDelayMs,
  processingWorkerPollIntervalMs,
  serverURL = "http://localhost:3000",
  uploadsDirectory = "./data/uploads",
}: BuildServerOptions) => {
  const server = Fastify({ logger, routerOptions: { ignoreTrailingSlash: true } })
  const pendingReadability = new Map<string, Promise<string | null>>()
  const pendingSummaries = new Map<string, Promise<string>>()
  const pendingTranslations = new Map<string, Promise<Record<string, string>>>()
  let registrationTail = Promise.resolve()
  let lastCleanup: { at: Date; report: MaintenanceCleanupReport } | null = null
  let lastFeedPollingCycle: {
    at: Date
    result: Awaited<ReturnType<typeof refreshSubscribedFeeds>>
  } | null = null

  const resolveAIProvider = async (userId: string): Promise<AIProvider> => {
    if (aiProvider) return aiProvider
    const stored = await dataStore.getAIProviderConfig(userId)
    if (stored) {
      if (!aiEncryptionSecret) {
        throw new ProcessingError(
          "ai_encryption_unavailable",
          "AI credential encryption is not configured",
        )
      }
      return new OpenAICompatibleProvider({
        apiKey: decryptCredential(stored.encryptedApiKey, aiEncryptionSecret),
        baseUrl: stored.baseUrl,
        fetch: aiProviderFetch,
        model: stored.model,
      })
    }
    if (aiProviderConfig) {
      return new OpenAICompatibleProvider({ ...aiProviderConfig, fetch: aiProviderFetch })
    }
    throw new ProcessingError("ai_provider_not_configured", "Configure an AI provider first")
  }

  const processingService = new ProcessingService({
    dataStore,
    maxAttempts: processingMaxAttempts,
    onCleanup: (report) => {
      lastCleanup = { at: new Date(), report }
      server.log.info(report, "Maintenance cleanup completed")
    },
    onError: (error) => server.log.error(error, "Processing worker failed"),
    pollIntervalMs: processingWorkerPollIntervalMs,
    resolveProvider: resolveAIProvider,
    retryBaseDelayMs: processingRetryBaseDelayMs,
  })
  processingService.start()
  server.addHook("onClose", async () => processingService.stop())

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value)

  const actionMatchesEntry = (rule: Record<string, unknown>, entry: EntryRecord): boolean => {
    const conditions = Array.isArray(rule.condition) ? rule.condition : []
    if (conditions.length === 0) return true
    const groups = Array.isArray(conditions[0]) ? conditions : [conditions]
    const fieldValue = (field: unknown): string => {
      switch (field) {
        case "entry_title":
          return entry.title ?? ""
        case "entry_content":
          return entry.content ?? entry.description ?? ""
        case "entry_url":
          return entry.url ?? ""
        case "entry_author":
          return entry.author ?? ""
        default:
          return ""
      }
    }
    const matchesCondition = (condition: unknown): boolean => {
      if (!isRecord(condition)) return false
      const actual = fieldValue(condition.field)
      const expected = String(condition.value ?? "")
      switch (condition.operator) {
        case "contains":
          return actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
        case "not_contains":
          return !actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
        case "eq":
          return actual === expected
        case "not_eq":
          return actual !== expected
        case "regex":
          try {
            return new RegExp(expected, "i").test(actual)
          } catch {
            return false
          }
        default:
          return false
      }
    }
    return groups.some(
      (group) => Array.isArray(group) && group.length > 0 && group.every(matchesCondition),
    )
  }

  const enqueueImportedEntries = async (entries: EntryRecord[], importedUserId: string | null) => {
    const userId = importedUserId ?? (await dataStore.getOwnerUserId())
    if (!userId) return
    const actionRecord = await dataStore.getActionRules(userId)
    const evaluationRules = (actionRecord?.rules ?? []).filter((rule) => {
      const result = isRecord(rule.result) ? rule.result : null
      return result?.disabled !== true && Boolean(result?.evaluate)
    })
    if (evaluationRules.length === 0) return
    const actionPriority = (rule: Record<string, unknown>): number => {
      const result = isRecord(rule.result) ? rule.result : null
      const evaluate = result && isRecord(result.evaluate) ? result.evaluate : null
      if (typeof evaluate?.priority === "number") return evaluate.priority
      if (evaluate?.priority === "high") return 5
      if (evaluate?.priority === "low") return -5
      return 0
    }
    await Promise.all(
      entries.map(async (entry) => {
        const matchingRules = evaluationRules.filter((rule) => actionMatchesEntry(rule, entry))
        if (matchingRules.length === 0) return
        try {
          await processingService.enqueueEvaluation(userId, entry.id, {
            automatic: true,
            priority: Math.max(...matchingRules.map(actionPriority)),
          })
        } catch (error) {
          if (!(error instanceof ProcessingError)) throw error
        }
      }),
    )
  }

  const importer = feedFetcher
    ? new FeedImporter(
        dataStore,
        feedFetcher,
        async ({ entries, userId }) => {
          try {
            await enqueueImportedEntries(entries, userId)
          } catch (error) {
            server.log.error(error, "Automatic entry processing failed after feed import")
          }
        },
        {
          refreshIntervalMs: feedPollIntervalMs,
          retryBaseDelayMs: feedRetryBaseDelayMs,
        },
      )
    : null
  if (importer && feedPollIntervalMs) {
    const stopFeedScheduler = startFeedScheduler({
      dataStore,
      importer,
      concurrency: feedPollConcurrency,
      intervalMs: feedPollIntervalMs,
      onResult: (result) => {
        lastFeedPollingCycle = { at: new Date(), result }
        server.log.info(result, "Feed polling cycle completed")
      },
    })
    server.addHook("onClose", async () => stopFeedScheduler())
  }

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
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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

  server.get("/ready", async (_request, reply) => {
    try {
      await dataStore.checkHealth()
      return { status: "ready" }
    } catch (error) {
      server.log.error(error, "Readiness check failed")
      return reply.status(503).send({ status: "unavailable" })
    }
  })

  server.get("/metrics", async (_request, reply) => {
    const stats = await dataStore.getOperationalStats(new Date())
    const lines = [
      "# HELP folo_subscribed_feeds Number of distinct subscribed feeds.",
      "# TYPE folo_subscribed_feeds gauge",
      `folo_subscribed_feeds ${stats.subscribedFeeds}`,
      "# HELP folo_feed_acquisition_failures Subscribed feeds currently in backoff.",
      "# TYPE folo_feed_acquisition_failures gauge",
      `folo_feed_acquisition_failures ${stats.feedAcquisitionFailures}`,
      "# HELP folo_feeds_due Subscribed feeds currently due for polling.",
      "# TYPE folo_feeds_due gauge",
      `folo_feeds_due ${stats.feedsDue}`,
      "# HELP folo_processing_jobs Processing jobs by status.",
      "# TYPE folo_processing_jobs gauge",
      ...Object.entries(stats.processingJobs).map(
        ([status, count]) => `folo_processing_jobs{status="${status}"} ${count}`,
      ),
      "",
    ]
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(lines.join("\n"))
  })

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
        stage: 4,
        capabilities,
        unavailable: capabilityManifest.capabilities
          .map((capability) => capability.id)
          .filter((id) => !enabled.has(id)),
      },
    }
  })

  server.get("/api/extensions/operations/status", async (request, reply) => {
    const session = await authenticatedSession(request.headers)
    if (!session) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    if ((await dataStore.getOwnerUserId()) !== session.user.id) {
      return reply.status(403).send({ code: "forbidden", message: "Instance owner required" })
    }
    const stats = await dataStore.getOperationalStats(new Date())
    const alerts = [
      ...(stats.feedAcquisitionFailures > 0
        ? [
            {
              code: "feed_acquisition_degraded",
              count: stats.feedAcquisitionFailures,
              severity: "warning" as const,
            },
          ]
        : []),
      ...(stats.processingJobs.failed > 0
        ? [
            {
              code: "processing_jobs_failed",
              count: stats.processingJobs.failed,
              severity: "warning" as const,
            },
          ]
        : []),
    ]
    return {
      code: 0,
      data: {
        alerts,
        last_cleanup: lastCleanup
          ? { at: lastCleanup.at.toISOString(), report: lastCleanup.report }
          : null,
        last_feed_polling_cycle: lastFeedPollingCycle
          ? {
              at: lastFeedPollingCycle.at.toISOString(),
              result: lastFeedPollingCycle.result,
            }
          : null,
        stats,
        status: alerts.length > 0 ? ("degraded" as const) : ("healthy" as const),
      },
    }
  })

  server.get<{ Params: { feedId: string } }>(
    "/api/extensions/subscriptions/:feedId/acquisition",
    async (request, reply) => {
      const userId = await authenticatedUserId(request.headers)
      if (!userId) {
        return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
      }
      const subscription = await subscriptionForFeed(userId, request.params.feedId)
      const feed = subscription ? await dataStore.getFeed(subscription.feedId) : null
      if (!feed) {
        return reply
          .status(404)
          .send({ code: "subscription_not_found", message: "Subscription not found" })
      }
      return {
        code: 0,
        data: {
          active_provider: importer?.providerId ?? ("standard_rss" as const),
          consecutive_failures: feed.consecutiveFailures,
          feed_id: feed.id,
          last_error_at: feed.errorAt?.toISOString() ?? null,
          last_error_summary: feed.errorMessage,
          last_success_at: feed.lastSuccessAt?.toISOString() ?? null,
          next_fetch_at: feed.nextFetchAt.toISOString(),
          preferred_provider: importer?.providerId ?? ("standard_rss" as const),
          status: feed.consecutiveFailures > 0 ? ("degraded" as const) : ("healthy" as const),
        },
      }
    },
  )

  server.get<{ Params: { feedId: string } }>(
    "/api/extensions/subscriptions/:feedId/acquisition/diagnostics",
    async (request, reply) => {
      const userId = await authenticatedUserId(request.headers)
      if (!userId) {
        return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
      }
      const subscription = await subscriptionForFeed(userId, request.params.feedId)
      const feed = subscription ? await dataStore.getFeed(subscription.feedId) : null
      if (!feed) {
        return reply
          .status(404)
          .send({ code: "subscription_not_found", message: "Subscription not found" })
      }
      const query = request.query as Record<string, unknown>
      const limit = limitFromUnknown(query.limit, 20, 100)
      const attempts = await dataStore.listFeedFetchAttempts(feed.id, limit)
      return {
        code: 0,
        data: {
          items: attempts.map((attempt) => ({
            duration_ms: attempt.durationMs,
            entry_count: attempt.entryCount,
            error_code: attempt.errorCode,
            error_summary: attempt.errorSummary,
            finished_at: attempt.finishedAt.toISOString(),
            http_status: attempt.httpStatus,
            id: attempt.id,
            response_url: attempt.responseUrl,
            started_at: attempt.startedAt.toISOString(),
            status: attempt.status,
          })),
          limit,
        },
      }
    },
  )

  server.get("/api/extensions/ai/provider", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const config = await dataStore.getAIProviderConfig(userId)
    const environmentConfig = !config && aiProviderConfig ? aiProviderConfig : null
    return {
      code: 0,
      data: config
        ? {
            base_url: config.baseUrl,
            configured: true,
            key_hint: config.keyHint,
            key_source: "stored" as const,
            model: config.model,
            type: config.type,
          }
        : environmentConfig
          ? {
              base_url: environmentConfig.baseUrl,
              configured: true,
              key_hint: null,
              key_source: "environment" as const,
              model: environmentConfig.model,
              type: "openai-compatible" as const,
            }
          : {
              base_url: null,
              configured: false,
              key_hint: null,
              key_source: null,
              model: null,
              type: "openai-compatible" as const,
            },
    }
  })

  server.put("/api/extensions/ai/provider", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    if (!aiEncryptionSecret) {
      return reply.status(503).send({
        code: "ai_encryption_unavailable",
        message: "AI credential encryption is not configured",
      })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (
      typeof body.api_key !== "string" ||
      body.api_key.trim() === "" ||
      typeof body.base_url !== "string" ||
      typeof body.model !== "string" ||
      body.model.trim() === ""
    ) {
      return reply.status(400).send({
        code: "invalid_ai_provider",
        message: "api_key, base_url, and model are required",
      })
    }

    try {
      const baseUrl = normalizeProviderBaseURL(body.base_url)
      const apiKey = body.api_key.trim()
      const config = {
        baseUrl,
        encryptedApiKey: encryptCredential(apiKey, aiEncryptionSecret),
        keyHint: credentialHint(apiKey),
        model: body.model.trim(),
        type: "openai-compatible" as const,
        updatedAt: new Date(),
        userId,
      }
      await dataStore.setAIProviderConfig(config)
      return {
        code: 0,
        data: {
          base_url: config.baseUrl,
          configured: true,
          key_hint: config.keyHint,
          key_source: "stored" as const,
          model: config.model,
          type: config.type,
        },
      }
    } catch (error) {
      return reply.status(400).send({
        code: "invalid_ai_provider",
        message: error instanceof Error ? error.message : "Invalid AI provider configuration",
      })
    }
  })

  server.delete("/api/extensions/ai/provider", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    await dataStore.deleteAIProviderConfig(userId)
    return { code: 0, data: null }
  })

  server.get("/api/extensions/profiles", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const snapshots = await dataStore.listProcessingProfileSnapshots(userId)
    return {
      code: 0,
      data: {
        current: snapshots.at(0) ?? null,
        snapshots,
      },
    }
  })

  server.post("/api/extensions/profiles", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (
      typeof body.name !== "string" ||
      body.name.trim() === "" ||
      !body.content ||
      typeof body.content !== "object" ||
      Array.isArray(body.content)
    ) {
      return reply.status(400).send({
        code: "invalid_profile",
        message: "name and object content are required",
      })
    }
    const name = body.name.trim()
    const content = structuredClone(body.content as Record<string, unknown>)
    const existing = (await dataStore.listProcessingProfileSnapshots(userId)).filter(
      (snapshot) => snapshot.name === name,
    )
    const matching = existing.find((snapshot) => snapshot.contentHash === contentHash(content))
    if (matching) return { code: 0, data: matching }
    const snapshot = await dataStore.createProcessingProfileSnapshot({
      content,
      contentHash: contentHash(content),
      createdAt: new Date(),
      id: `profile_${randomUUID().replaceAll("-", "")}`,
      name,
      userId,
      version: Math.max(0, ...existing.map((item) => item.version)) + 1,
    })
    return reply.status(201).send({ code: 0, data: snapshot })
  })

  server.get("/api/extensions/taxonomies", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const snapshots = await dataStore.listProcessingTaxonomySnapshots(userId)
    return {
      code: 0,
      data: {
        current: snapshots.at(0) ?? null,
        snapshots,
      },
    }
  })

  server.post("/api/extensions/taxonomies", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (
      typeof body.name !== "string" ||
      body.name.trim() === "" ||
      !body.content ||
      typeof body.content !== "object" ||
      Array.isArray(body.content)
    ) {
      return reply.status(400).send({
        code: "invalid_taxonomy",
        message: "name and object content are required",
      })
    }
    const name = body.name.trim()
    const content = structuredClone(body.content as Record<string, unknown>)
    const existing = (await dataStore.listProcessingTaxonomySnapshots(userId)).filter(
      (snapshot) => snapshot.name === name,
    )
    const matching = existing.find((snapshot) => snapshot.contentHash === contentHash(content))
    if (matching) return { code: 0, data: matching }
    const snapshot = await dataStore.createProcessingTaxonomySnapshot({
      content,
      contentHash: contentHash(content),
      createdAt: new Date(),
      id: `taxonomy_${randomUUID().replaceAll("-", "")}`,
      name,
      userId,
      version: Math.max(0, ...existing.map((item) => item.version)) + 1,
    })
    return reply.status(201).send({ code: 0, data: snapshot })
  })

  const currentProcessingConfiguration = async (userId: string) => {
    const [profile, taxonomy] = await Promise.all([
      dataStore.listProcessingProfileSnapshots(userId),
      dataStore.listProcessingTaxonomySnapshots(userId),
    ])
    return { profileId: profile.at(0)?.id ?? null, taxonomyId: taxonomy.at(0)?.id ?? null }
  }

  const evaluationIsOutdated = (
    evaluation: EntryEvaluationRecord,
    current: Awaited<ReturnType<typeof currentProcessingConfiguration>>,
  ) =>
    evaluation.processorVersion !== "1" ||
    evaluation.scoreFormulaVersion !== "weighted-v1" ||
    current.profileId !== evaluation.profileSnapshotId ||
    current.taxonomyId !== evaluation.taxonomySnapshotId

  const isEvaluationOutdated = async (userId: string, evaluation: EntryEvaluationRecord) => {
    return evaluationIsOutdated(evaluation, await currentProcessingConfiguration(userId))
  }

  server.post("/api/extensions/processing/jobs", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.entry_id !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "entry_id is required" })
    }
    try {
      const result = await processingService.enqueueEvaluation(userId, body.entry_id, {
        forceRerun: body.force_rerun === true,
        ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
        ...(typeof body.profile_snapshot_id === "string"
          ? { profileSnapshotId: body.profile_snapshot_id }
          : {}),
        ...(typeof body.taxonomy_snapshot_id === "string"
          ? { taxonomySnapshotId: body.taxonomy_snapshot_id }
          : {}),
      })
      if (result.outcome === "already_satisfied") {
        return {
          code: 0,
          data: {
            evaluation: apiEvaluation(
              result.evaluation,
              await isEvaluationOutdated(userId, result.evaluation),
            ),
            outcome: result.outcome,
          },
        }
      }
      if (result.outcome === "failed_requires_retry") {
        return reply.status(409).send({
          code: "processing_job_requires_retry",
          message: "The previous processing job failed and requires an explicit retry",
        })
      }
      return reply.status(result.outcome === "created" ? 202 : 200).send({
        code: 0,
        data: {
          job: apiProcessingJob(result.job),
          outcome: result.outcome,
          ...(result.outcome === "created" ? { superseded: result.supersededCount } : {}),
        },
      })
    } catch (error) {
      if (error instanceof ProcessingError) {
        const status = error.code === "entry_not_found" ? 404 : 409
        return reply.status(status).send({ code: error.code, message: error.message })
      }
      throw error
    }
  })

  server.get<{ Params: { jobId: string } }>(
    "/api/extensions/processing/jobs/:jobId",
    async (request, reply) => {
      const userId = await authenticatedUserId(request.headers)
      if (!userId) {
        return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
      }
      const job = await dataStore.getProcessingJob(userId, request.params.jobId)
      if (!job) {
        return reply
          .status(404)
          .send({ code: "processing_job_not_found", message: "Job not found" })
      }
      const attempts = await dataStore.listProcessingAttempts(userId, job.id)
      return {
        code: 0,
        data: { ...apiProcessingJob(job), attempts: attempts.map(apiProcessingAttempt) },
      }
    },
  )

  server.post<{ Params: { jobId: string } }>(
    "/api/extensions/processing/jobs/:jobId/retry",
    async (request, reply) => {
      const userId = await authenticatedUserId(request.headers)
      if (!userId) {
        return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
      }
      const job = await dataStore.retryProcessingJob(userId, request.params.jobId)
      if (!job) {
        return reply.status(409).send({
          code: "processing_job_not_retryable",
          message: "Only failed jobs can be retried",
        })
      }
      processingService.kick()
      return reply.status(202).send({ code: 0, data: apiProcessingJob(job) })
    },
  )

  server.get<{ Params: { entryId: string } }>(
    "/api/extensions/entries/:entryId/evaluation",
    async (request, reply) => {
      const userId = await authenticatedUserId(request.headers)
      if (!userId) {
        return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
      }
      if (!(await dataStore.getEntry(userId, request.params.entryId))) {
        return reply.status(404).send({ code: "entry_not_found", message: "Entry not found" })
      }
      const [current, history] = await Promise.all([
        dataStore.getCurrentEntryEvaluation(userId, request.params.entryId),
        dataStore.listEntryEvaluations(userId, request.params.entryId),
      ])
      const configuration = await currentProcessingConfiguration(userId)
      const outdated = new Map(
        history.map((evaluation) => [
          evaluation.id,
          evaluationIsOutdated(evaluation, configuration),
        ]),
      )
      return {
        code: 0,
        data: {
          current: current ? apiEvaluation(current, outdated.get(current.id) ?? false) : null,
          history: history.map((evaluation) =>
            apiEvaluation(evaluation, outdated.get(evaluation.id) ?? false),
          ),
        },
      }
    },
  )

  server.post<{ Params: { entryId: string; evaluationId: string } }>(
    "/api/extensions/entries/:entryId/evaluation/:evaluationId/select",
    async (request, reply) => {
      const userId = await authenticatedUserId(request.headers)
      if (!userId) {
        return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
      }
      const body = (request.body ?? {}) as Record<string, unknown>
      const evaluation = await dataStore.selectEntryEvaluation(
        userId,
        request.params.entryId,
        request.params.evaluationId,
        typeof body.reason === "string" ? body.reason : "manual_selection",
      )
      if (!evaluation) {
        return reply
          .status(404)
          .send({ code: "evaluation_not_found", message: "Evaluation not found" })
      }
      return {
        code: 0,
        data: apiEvaluation(evaluation, await isEvaluationOutdated(userId, evaluation)),
      }
    },
  )

  server.get<{ Params: { entryId: string } }>(
    "/api/extensions/entries/:entryId/processing-status",
    async (request, reply) => {
      const userId = await authenticatedUserId(request.headers)
      if (!userId) {
        return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
      }
      if (!(await dataStore.getEntry(userId, request.params.entryId))) {
        return reply.status(404).send({ code: "entry_not_found", message: "Entry not found" })
      }
      const jobs = await dataStore.getEntryProcessingJobs(userId, request.params.entryId)
      return {
        code: 0,
        data: {
          current: jobs.at(0) ? apiProcessingJob(jobs[0]!) : null,
          jobs: jobs.map(apiProcessingJob),
        },
      }
    },
  )

  server.post("/api/extensions/entries/projections", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const entryIds = Array.isArray(body.entry_ids)
      ? [...new Set(body.entry_ids.filter((id): id is string => typeof id === "string"))]
      : []
    if (entryIds.length > 100) {
      return reply.status(400).send({ code: "too_many_entries", message: "At most 100 entries" })
    }
    const [entryProjections, configuration] = await Promise.all([
      dataStore.getEntryProjections(userId, entryIds),
      currentProcessingConfiguration(userId),
    ])
    const projections = entryIds.map((entryId) => {
      const projection = entryProjections[entryId]!
      const evaluation = projection.evaluation
      return [
        entryId,
        {
          evaluation: evaluation
            ? apiEvaluation(evaluation, evaluationIsOutdated(evaluation, configuration))
            : null,
          processing_status: projection.processingJob
            ? apiProcessingJob(projection.processingJob)
            : null,
        },
      ] as const
    })
    return { code: 0, data: Object.fromEntries(projections) }
  })

  const entriesForReevaluation = async (userId: string, body: Record<string, unknown>) => {
    if (Array.isArray(body.entry_ids)) {
      const ids = [...new Set(body.entry_ids.filter((id): id is string => typeof id === "string"))]
      if (ids.length > 1_000) {
        throw new ProcessingError("too_many_entries", "At most 1000 entries can be submitted")
      }
      return (await Promise.all(ids.map((entryId) => dataStore.getEntry(userId, entryId)))).filter(
        (entry): entry is EntryRecord => entry !== null,
      )
    }
    return (
      await dataStore.listEntries({
        userId,
        ...(typeof body.feed_id === "string" ? { feedId: body.feed_id } : {}),
        ...(Array.isArray(body.feed_ids)
          ? {
              feedIdList: body.feed_ids.filter(
                (feedId): feedId is string => typeof feedId === "string",
              ),
            }
          : {}),
        ...(typeof body.view === "number" ? { view: body.view } : {}),
        ...(dateFromUnknown(body.published_after)
          ? { publishedAfter: dateFromUnknown(body.published_after) }
          : {}),
        ...(dateFromUnknown(body.published_before)
          ? { publishedBefore: dateFromUnknown(body.published_before) }
          : {}),
        limit: limitFromUnknown(body.limit, 100, 1_000),
      })
    ).map((row) => row.entry)
  }

  server.post("/api/extensions/processing/re-evaluation-preview", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    try {
      const [entries, profiles, taxonomies] = await Promise.all([
        entriesForReevaluation(userId, body),
        dataStore.listProcessingProfileSnapshots(userId),
        dataStore.listProcessingTaxonomySnapshots(userId),
      ])
      const profile =
        typeof body.profile_snapshot_id === "string"
          ? await dataStore.getProcessingProfileSnapshot(userId, body.profile_snapshot_id)
          : profiles.at(0)
      const taxonomy =
        typeof body.taxonomy_snapshot_id === "string"
          ? await dataStore.getProcessingTaxonomySnapshot(userId, body.taxonomy_snapshot_id)
          : taxonomies.at(0)
      if (!profile || !taxonomy) {
        throw new ProcessingError(
          "processing_configuration_required",
          "Create a profile and taxonomy before re-evaluation",
        )
      }
      let alreadySatisfied = 0
      let active = 0
      for (const entry of entries) {
        const [current, jobs] = await Promise.all([
          dataStore.getCurrentEntryEvaluation(userId, entry.id),
          dataStore.getEntryProcessingJobs(userId, entry.id),
        ])
        if (
          current &&
          current.contentFingerprint === entryContentFingerprint(entry) &&
          current.processorVersion === "1" &&
          current.scoreFormulaVersion === "weighted-v1" &&
          current.profileSnapshotId === profile.id &&
          current.taxonomySnapshotId === taxonomy.id
        ) {
          alreadySatisfied += 1
        }
        if (jobs.some((job) => job.status === "queued" || job.status === "running")) active += 1
      }
      const forceRerun = body.force_rerun === true
      return {
        code: 0,
        data: {
          active,
          already_satisfied: alreadySatisfied,
          estimated_calls: Math.max(
            0,
            entries.length - active - (forceRerun ? 0 : alreadySatisfied),
          ),
          matched: entries.length,
          profile_snapshot_id: profile.id,
          taxonomy_snapshot_id: taxonomy.id,
        },
      }
    } catch (error) {
      if (error instanceof ProcessingError) {
        return reply.status(400).send({ code: error.code, message: error.message })
      }
      throw error
    }
  })

  server.post("/api/extensions/processing/re-evaluation-jobs", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    try {
      const entries = await entriesForReevaluation(userId, body)
      const result = {
        already_satisfied: 0,
        created: 0,
        job_ids: [] as string[],
        matched: entries.length,
        reused: 0,
        skipped: 0,
        superseded: 0,
      }
      for (const entry of entries) {
        try {
          const enqueued = await processingService.enqueueEvaluation(userId, entry.id, {
            forceRerun: body.force_rerun === true,
            ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
            ...(typeof body.profile_snapshot_id === "string"
              ? { profileSnapshotId: body.profile_snapshot_id }
              : {}),
            ...(typeof body.taxonomy_snapshot_id === "string"
              ? { taxonomySnapshotId: body.taxonomy_snapshot_id }
              : {}),
          })
          if (enqueued.outcome === "already_satisfied") result.already_satisfied += 1
          else if (enqueued.outcome === "failed_requires_retry") result.skipped += 1
          else {
            result[enqueued.outcome] += 1
            if (enqueued.outcome === "created") {
              result.superseded += enqueued.supersededCount
            }
            result.job_ids.push(enqueued.job.id)
          }
        } catch (error) {
          if (error instanceof ProcessingError) result.skipped += 1
          else throw error
        }
      }
      return reply.status(202).send({ code: 0, data: result })
    } catch (error) {
      if (error instanceof ProcessingError) {
        return reply.status(400).send({ code: error.code, message: error.message })
      }
      throw error
    }
  })

  server.get("/ai/summary", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const query = request.query as Record<string, unknown>
    if (typeof query.id !== "string") {
      return reply.status(400).send({ code: "invalid_request", message: "id is required" })
    }
    const language = typeof query.language === "string" ? query.language : "auto"
    const target = query.target === "readabilityContent" ? "readabilityContent" : "content"
    const cached = await dataStore.getEntrySummary(userId, query.id, language, target)
    if (cached) return { code: 0, data: cached.summary }
    const entry = await dataStore.getEntry(userId, query.id)
    if (!entry) {
      return reply.status(404).send({ code: "entry_not_found", message: "Entry not found" })
    }

    const cacheKey = `${userId}:${entry.id}:${language}:${target}`
    let pending = pendingSummaries.get(cacheKey)
    if (!pending) {
      pending = (async () => {
        const readability =
          target === "readabilityContent" ? await dataStore.getReadability(userId, entry.id) : null
        const source = readability?.content ?? entry.content ?? entry.description ?? entry.title
        if (!source)
          throw new ProcessingError("entry_content_missing", "Entry has no text to summarize")
        const completion = await (
          await resolveAIProvider(userId)
        ).complete({
          system:
            "Summarize an RSS entry faithfully and concisely. Do not invent facts. Return only the summary text.",
          temperature: 0.2,
          user: JSON.stringify({
            language,
            source,
            title: entry.title,
            url: entry.url,
          }),
        })
        const summary = completion.content.trim()
        await dataStore.setEntrySummary(userId, {
          createdAt: new Date(),
          entryId: entry.id,
          language,
          model: completion.model,
          summary,
          target,
        })
        return summary
      })().finally(() => pendingSummaries.delete(cacheKey))
      pendingSummaries.set(cacheKey, pending)
    }
    try {
      return { code: 0, data: await pending }
    } catch (error) {
      const failure =
        error instanceof ProcessingError
          ? { code: error.code, message: error.message }
          : {
              code: "ai_provider_error",
              message: error instanceof Error ? error.message : "Summary generation failed",
            }
      return reply.status(502).send(failure)
    }
  })

  server.post("/ai/translation/batch", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.filter((id): id is string => typeof id === "string"))].slice(0, 100)
      : []
    const language = typeof body.language === "string" ? body.language : null
    const allowedFields = new Set(["title", "description", "content", "readabilityContent"])
    const fields =
      typeof body.fields === "string"
        ? [...new Set(body.fields.split(",").filter((field) => allowedFields.has(field)))]
        : []
    if (!language || ids.length === 0 || fields.length === 0) {
      return reply.status(400).send({
        code: "invalid_request",
        message: "ids, language, and fields are required",
      })
    }

    try {
      const chunks = await Promise.all(
        ids.map(async (entryId) => {
          const entry = await dataStore.getEntry(userId, entryId)
          if (!entry) return null
          const cached = await dataStore.getEntryTranslation(userId, entryId, language)
          const cachedData: Record<string, string> = {}
          for (const field of fields) {
            const value =
              field === "readabilityContent"
                ? cached?.readabilityContent
                : cached?.[field as "content" | "description" | "title"]
            if (value) cachedData[field] = value
          }
          if (Object.keys(cachedData).length === fields.length) {
            return { data: cachedData, id: entryId }
          }

          const cacheKey = `${userId}:${entryId}:${language}:${fields.join(",")}`
          let pending = pendingTranslations.get(cacheKey)
          if (!pending) {
            pending = (async () => {
              const readability = fields.includes("readabilityContent")
                ? await dataStore.getReadability(userId, entryId)
                : null
              const source = Object.fromEntries(
                fields.flatMap((field) => {
                  const value =
                    field === "readabilityContent"
                      ? readability?.content
                      : entry[field as "content" | "description" | "title"]
                  return value ? [[field, value]] : []
                }),
              )
              const completion = await (
                await resolveAIProvider(userId)
              ).complete({
                json: true,
                system:
                  "Translate the provided RSS entry fields. Preserve HTML structure when present. Return only a JSON object whose keys exactly match the input fields.",
                temperature: 0.1,
                user: JSON.stringify({
                  language,
                  mode: body.mode === "translation-only" ? "translation-only" : "bilingual",
                  source,
                }),
              })
              const parsed = JSON.parse(
                completion.content
                  .trim()
                  .replace(/^```(?:json)?\s*/i, "")
                  .replace(/\s*```$/, ""),
              ) as Record<string, unknown>
              const translated: Record<string, string> = {}
              for (const field of fields) {
                if (typeof parsed[field] === "string") translated[field] = parsed[field]
              }
              if (Object.keys(translated).length === 0) {
                throw new Error("AI provider returned no translated fields")
              }
              await dataStore.setEntryTranslation(userId, {
                content: translated.content ?? cached?.content ?? null,
                createdAt: new Date(),
                description: translated.description ?? cached?.description ?? null,
                entryId,
                language,
                model: completion.model,
                readabilityContent:
                  translated.readabilityContent ?? cached?.readabilityContent ?? null,
                title: translated.title ?? cached?.title ?? null,
              })
              return translated
            })().finally(() => pendingTranslations.delete(cacheKey))
            pendingTranslations.set(cacheKey, pending)
          }
          return { data: await pending, id: entryId }
        }),
      )
      const responseBody = chunks
        .filter((chunk) => chunk !== null)
        .map((chunk) => JSON.stringify(chunk))
        .join("\n")
      return reply
        .type("application/x-ndjson; charset=utf-8")
        .send(`${responseBody}${responseBody ? "\n" : ""}`)
    } catch (error) {
      return reply.status(502).send({
        code: "ai_provider_error",
        message: error instanceof Error ? error.message : "Translation failed",
      })
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
      MAX_ACTIONS: 100,
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

  server.get("/actions", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const record = await dataStore.getActionRules(userId)
    return {
      code: 0,
      data: record
        ? {
            createdAt: record.createdAt.toISOString(),
            rules: record.rules,
            updatedAt: record.updatedAt.toISOString(),
            userId: record.userId,
          }
        : null,
    }
  })

  server.put("/actions", async (request, reply) => {
    const userId = await authenticatedUserId(request.headers)
    if (!userId) {
      return reply.status(401).send({ code: "unauthorized", message: "Authentication required" })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (
      !Array.isArray(body.rules) ||
      body.rules.length > 100 ||
      !body.rules.every((rule) => isRecord(rule))
    ) {
      return reply.status(400).send({
        code: "invalid_action_rules",
        message: "rules must contain at most 100 action objects",
      })
    }
    await dataStore.setActionRules(
      userId,
      body.rules.map((rule) => structuredClone(rule as Record<string, unknown>)),
    )
    return { code: 0, data: null }
  })

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

    try {
      await importer.refresh(feed)
      return { code: 0, data: null }
    } catch (error) {
      server.log.warn({ error, feedId: feed.id }, "Manual feed refresh failed")
      return reply.status(502).send({
        code: "feed_refresh_failed",
        message: error instanceof Error ? error.message.slice(0, 500) : "Feed refresh failed",
      })
    }
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
    try {
      await importer.refresh(feed)
      return { code: 0, data: null }
    } catch (error) {
      server.log.warn({ error, feedId: feed.id }, "Feed reset refresh failed")
      return reply.status(502).send({
        code: "feed_refresh_failed",
        message: error instanceof Error ? error.message.slice(0, 500) : "Feed refresh failed",
      })
    }
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
    const aiSort = body.aiSort === true
    const requestedLimit = limitFromUnknown(body.limit, 20, 100)
    let rows = await dataStore.listEntries({
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
      limit: aiSort ? 1_000 : requestedLimit,
    })
    if (aiSort) {
      const now = new Date()
      const [projections, taxonomies] = await Promise.all([
        dataStore.getEntryProjections(
          userId,
          rows.map((row) => row.entry.id),
        ),
        dataStore.listProcessingTaxonomySnapshots(userId),
      ])
      const taxonomyById = new Map(taxonomies.map((taxonomy) => [taxonomy.id, taxonomy]))
      const featuredRows = rows.map((row) => {
        const evaluation = projections[row.entry.id]?.evaluation
        if (!evaluation || evaluation.overallScore < FEATURED_SCORE_THRESHOLD) return null
        const taxonomy = taxonomyById.get(evaluation.taxonomySnapshotId) ?? null
        return {
          rankingScore: featuredRankingScore(row.entry, evaluation, taxonomy, now),
          row,
        }
      })
      rows = featuredRows
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort(
          (left, right) =>
            right.rankingScore - left.rankingScore ||
            right.row.entry.publishedAt.getTime() - left.row.entry.publishedAt.getTime(),
        )
        .slice(0, requestedLimit)
        .map((item) => item.row)
    }
    const feedById = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.entry.feedId))].map(
          async (feedId) => [feedId, await dataStore.getFeed(feedId)] as const,
        ),
      ),
    )
    const data = rows.map(({ entry, subscription, read, collectionCreatedAt }) => {
      const feed = feedById.get(entry.feedId)
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
    })

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
