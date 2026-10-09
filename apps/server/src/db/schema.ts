import { sql } from "drizzle-orm"
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import type { EntryRecord } from "../data/types"

export const feeds = pgTable(
  "feeds",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    title: text("title"),
    description: text("description"),
    siteUrl: text("site_url"),
    image: text("image"),
    ownerUserId: text("owner_user_id"),
    errorAt: timestamp("error_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    nextFetchAt: timestamp("next_fetch_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("feeds_url_unique").on(table.url)],
)

export const instanceMetadata = pgTable("instance_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
})

export const feedFetchAttempts = pgTable(
  "feed_fetch_attempts",
  {
    id: text("id").primaryKey(),
    feedId: text("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    httpStatus: integer("http_status"),
    responseUrl: text("response_url"),
    entryCount: integer("entry_count"),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
  },
  (table) => [index("feed_fetch_attempts_feed_finished_idx").on(table.feedId, table.finishedAt)],
)

export const entries = pgTable(
  "entries",
  {
    id: text("id").primaryKey(),
    feedId: text("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    guid: text("guid").notNull(),
    title: text("title"),
    description: text("description"),
    content: text("content"),
    url: text("url"),
    author: text("author"),
    authorUrl: text("author_url"),
    authorAvatar: text("author_avatar"),
    language: text("language"),
    categories: jsonb("categories").$type<EntryRecord["categories"]>(),
    attachments: jsonb("attachments").$type<EntryRecord["attachments"]>(),
    media: jsonb("media").$type<EntryRecord["media"]>(),
    extra: jsonb("extra").$type<EntryRecord["extra"]>(),
    insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("entries_feed_guid_unique").on(table.feedId, table.guid),
    index("entries_feed_published_idx").on(table.feedId, table.publishedAt),
  ],
)

export const entryReadability = pgTable("entry_readability", {
  entryId: text("entry_id")
    .primaryKey()
    .references(() => entries.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
})

export const aiProviderConfigs = pgTable("ai_provider_configs", {
  userId: text("user_id").primaryKey(),
  type: text("type").notNull(),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  keyHint: text("key_hint").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
})

export const processingProfileSnapshots = pgTable(
  "processing_profile_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("processing_profile_name_version_unique").on(
      table.userId,
      table.name,
      table.version,
    ),
    index("processing_profile_latest_idx").on(table.userId, table.name, table.version),
  ],
)

export const processingTaxonomySnapshots = pgTable(
  "processing_taxonomy_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("processing_taxonomy_name_version_unique").on(
      table.userId,
      table.name,
      table.version,
    ),
    index("processing_taxonomy_latest_idx").on(table.userId, table.name, table.version),
  ],
)

export const processingJobs = pgTable(
  "processing_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    processorName: text("processor_name").notNull(),
    processorVersion: text("processor_version").notNull(),
    scoreFormulaVersion: text("score_formula_version").notNull(),
    profileSnapshotId: text("profile_snapshot_id")
      .notNull()
      .references(() => processingProfileSnapshots.id),
    taxonomySnapshotId: text("taxonomy_snapshot_id")
      .notNull()
      .references(() => processingTaxonomySnapshots.id),
    contentFingerprint: text("content_fingerprint").notNull(),
    status: text("status").notNull(),
    priority: integer("priority").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorSummary: text("last_error_summary"),
    idempotencyKey: text("idempotency_key").notNull(),
    forceRerun: boolean("force_rerun").notNull(),
    supersededByJobId: text("superseded_by_job_id"),
  },
  (table) => [
    index("processing_jobs_queue_idx").on(table.status, table.nextRetryAt, table.priority),
    index("processing_jobs_entry_idx").on(table.userId, table.entryId, table.queuedAt),
    uniqueIndex("processing_jobs_active_idempotency_unique")
      .on(table.idempotencyKey)
      .where(sql`${table.status} in ('queued', 'running')`),
    uniqueIndex("processing_jobs_one_running_per_entry_unique")
      .on(table.userId, table.entryId, table.purpose)
      .where(sql`${table.status} = 'running'`),
  ],
)

export const processingAttempts = pgTable(
  "processing_attempts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => processingJobs.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorSummary: text("error_summary"),
    executionMetadata: jsonb("execution_metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("processing_attempt_job_number_unique").on(table.jobId, table.attemptNumber),
  ],
)

export const entryEvaluations = pgTable(
  "entry_evaluations",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    importanceScore: integer("importance_score").notNull(),
    timelinessScore: integer("timeliness_score").notNull(),
    relevanceScore: integer("relevance_score").notNull(),
    overallScore: integer("overall_score").notNull(),
    recommendationReason: text("recommendation_reason").notNull(),
    primaryCategory: text("primary_category").notNull(),
    secondaryCategory: text("secondary_category"),
    tags: jsonb("tags").$type<string[]>().notNull(),
    processorType: text("processor_type").notNull(),
    processorName: text("processor_name").notNull(),
    processorVersion: text("processor_version").notNull(),
    scoreFormulaVersion: text("score_formula_version").notNull(),
    profileSnapshotId: text("profile_snapshot_id")
      .notNull()
      .references(() => processingProfileSnapshots.id),
    taxonomySnapshotId: text("taxonomy_snapshot_id")
      .notNull()
      .references(() => processingTaxonomySnapshots.id),
    contentFingerprint: text("content_fingerprint").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (table) => [index("entry_evaluations_history_idx").on(table.entryId, table.processedAt)],
)

export const entryCurrentEvaluations = pgTable("entry_current_evaluations", {
  entryId: text("entry_id")
    .primaryKey()
    .references(() => entries.id, { onDelete: "cascade" }),
  evaluationId: text("evaluation_id")
    .notNull()
    .references(() => entryEvaluations.id, { onDelete: "cascade" }),
  selectedAt: timestamp("selected_at", { withTimezone: true }).notNull(),
  selectionReason: text("selection_reason").notNull(),
})

export const entrySummaries = pgTable(
  "entry_summaries",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    language: text("language").notNull(),
    target: text("target").notNull(),
    summary: text("summary").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.entryId, table.language, table.target] })],
)

export const entryTranslations = pgTable(
  "entry_translations",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    language: text("language").notNull(),
    title: text("title"),
    description: text("description"),
    content: text("content"),
    readabilityContent: text("readability_content"),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.entryId, table.language] })],
)

export const actionRules = pgTable("action_rules", {
  userId: text("user_id").primaryKey(),
  rules: jsonb("rules").$type<Array<Record<string, unknown>>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
})

export const subscriptions = pgTable(
  "subscriptions",
  {
    userId: text("user_id").notNull(),
    feedId: text("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    view: integer("view").notNull(),
    category: text("category"),
    title: text("title"),
    isPrivate: boolean("is_private").notNull(),
    hideFromTimeline: boolean("hide_from_timeline"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.feedId] }),
    index("subscriptions_user_view_idx").on(table.userId, table.view),
  ],
)

export const instanceOwnership = pgTable("instance_ownership", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
})

export const lists = pgTable(
  "lists",
  {
    id: text("id").primaryKey(),
    feedIds: text("feed_ids").array().notNull(),
    title: text("title").notNull(),
    description: text("description"),
    image: text("image"),
    view: integer("view").notNull(),
    fee: integer("fee").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("lists_owner_idx").on(table.ownerUserId)],
)

export const listSubscriptions = pgTable(
  "list_subscriptions",
  {
    userId: text("user_id").notNull(),
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    view: integer("view").notNull(),
    category: text("category"),
    title: text("title"),
    isPrivate: boolean("is_private").notNull(),
    hideFromTimeline: boolean("hide_from_timeline"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.listId] }),
    index("list_subscriptions_user_view_idx").on(table.userId, table.view),
  ],
)

export const readStates = pgTable(
  "read_states",
  {
    userId: text("user_id").notNull(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.entryId] })],
)

export const collections = pgTable(
  "collections",
  {
    userId: text("user_id").notNull(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.entryId] })],
)

export const settings = pgTable(
  "settings",
  {
    userId: text("user_id").notNull(),
    tab: text("tab").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.tab] })],
)

/**
 * Per-user change log replayed by the client sync engine. Ids come from one global sequence;
 * rows of one user are written under a per-user advisory lock as the last statement of the
 * transaction that made the change, so they become visible in id order.
 */
export const syncActions = pgTable(
  "sync_actions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id").notNull(),
    model: text("model").notNull(),
    modelId: text("model_id"),
    action: text("action").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index("sync_actions_user_id_id_idx").on(table.userId, table.id),
    index("sync_actions_created_at_idx").on(table.createdAt),
  ],
)

/** The highest id deleted from a user's log; an older cursor must take a fresh snapshot. */
export const syncFloors = pgTable("sync_floors", {
  userId: text("user_id").primaryKey(),
  floorId: bigint("floor_id", { mode: "number" }).notNull(),
})

/** Scheduled AI tasks (ADR-0036); the schedule and options keep the Folo client's JSON shape. */
export const aiTasks = pgTable(
  "ai_tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    isEnabled: boolean("is_enabled").notNull(),
    schedule: jsonb("schedule").$type<Record<string, unknown>>().notNull(),
    options: jsonb("options").$type<Record<string, unknown>>().notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    runCount: integer("run_count").notNull(),
    lastResult: text("last_result"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("ai_tasks_user_idx").on(table.userId, table.createdAt),
    index("ai_tasks_due_idx").on(table.isEnabled, table.nextRunAt),
  ],
)

/**
 * One row per task run. A scheduled slot is recorded once (`scheduled_for` unique per task), so a
 * restart or a second worker cannot produce the same report twice; test runs are not unique.
 */
export const aiTaskRuns = pgTable(
  "ai_task_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => aiTasks.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    candidateCount: integer("candidate_count"),
    selectedCount: integer("selected_count"),
    unevaluatedCount: integer("unevaluated_count"),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    usage: jsonb("usage").$type<Record<string, unknown>>(),
    sessionId: text("session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("ai_task_runs_scheduled_slot_unique")
      .on(table.taskId, table.scheduledFor)
      .where(sql`${table.kind} = 'scheduled'`),
    index("ai_task_runs_queue_idx").on(table.status, table.nextAttemptAt),
    index("ai_task_runs_task_idx").on(table.taskId, table.scheduledFor),
  ],
)

/** Report sessions shown through the client's AI chat session API; only task runs create them. */
export const aiChatSessions = pgTable(
  "ai_chat_sessions",
  {
    chatId: text("chat_id").primaryKey(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("ai_chat_sessions_user_idx").on(table.userId, table.updatedAt)],
)

export const aiChatMessages = pgTable(
  "ai_chat_messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => aiChatSessions.chatId, { onDelete: "cascade" }),
    role: text("role").notNull(),
    messageParts: jsonb("message_parts").$type<Array<Record<string, unknown>>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("ai_chat_messages_chat_idx").on(table.chatId, table.createdAt)],
)
