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
  consecutiveFailures: number
  lastSuccessAt: Date | null
  nextFetchAt: Date
}

export interface FeedFetchAttemptRecord {
  id: string
  feedId: string
  status: "failed" | "not_modified" | "succeeded"
  startedAt: Date
  finishedAt: Date
  durationMs: number
  httpStatus: number | null
  responseUrl: string | null
  entryCount: number | null
  errorCode: string | null
  errorSummary: string | null
}

export interface OperationalStats {
  subscribedFeeds: number
  feedAcquisitionFailures: number
  feedsDue: number
  processingJobs: Record<ProcessingJobStatus, number>
}

export interface MaintenanceCleanupReport {
  diagnosticPayloadsCleared: number
  entryEvaluationsDeleted: number
  feedFetchAttemptsDeleted: number
  processingAttemptsDeleted: number
  processingJobsDeleted: number
  syncActionsDeleted: number
}

/** Models the client sync engine understands; see docs/feeds-agent-integration/stage-4-3-incremental-sync.md. */
export type SyncModel =
  "action" | "collection" | "list" | "list_subscription" | "setting" | "subscription" | "timeline"

/** Insert, update, delete, and "new entries arrived" (a coalesced timeline insert). */
export type SyncActionType = "D" | "I" | "N" | "U"

export interface SyncActionInput {
  userId: string
  model: SyncModel
  /** feedId, listId, entryId or settings tab; null for batch timeline updates */
  modelId: string | null
  action: SyncActionType
  data: Record<string, unknown> | null
}

export interface SyncActionRecord extends SyncActionInput {
  /** Monotonically increasing across all users */
  id: number
  createdAt: Date
}

export interface SyncDelta {
  actions: SyncActionRecord[]
  lastSyncId: number
  hasMore: boolean
  /** The cursor predates the retained log; the client must take a fresh snapshot */
  reset: boolean
}

export interface UnreadSnapshot {
  counts: Record<string, number>
  /** Every action up to this id is reflected in `counts`, and none after it */
  lastSyncId: number
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

export interface ListRecord {
  id: string
  feedIds: string[]
  title: string
  description: string | null
  image: string | null
  view: number
  fee: number
  ownerUserId: string
  createdAt: Date
  updatedAt: Date
}

export interface ListSubscriptionRecord {
  userId: string
  listId: string
  view: number
  category: string | null
  title: string | null
  isPrivate: boolean
  hideFromTimeline: boolean | null
  createdAt: Date
}

export type ListPatch = Partial<
  Pick<ListRecord, "description" | "fee" | "image" | "title" | "view">
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
  /** Order by collection time for collections, otherwise publish time; newest first unless "asc". */
  sortOrder?: "asc" | "desc"
  limit: number
}

export interface MarkAllReadFilter {
  view?: number
  feedId?: string
  feedIdList?: string[]
}

export interface ReadabilityRecord {
  entryId: string
  content: string
  updatedAt: Date
}

export interface AIProviderConfigRecord {
  userId: string
  type: "openai-compatible"
  baseUrl: string
  model: string
  encryptedApiKey: string
  keyHint: string
  updatedAt: Date
}

export interface ProcessingProfileSnapshotRecord {
  id: string
  userId: string
  name: string
  version: number
  content: Record<string, unknown>
  contentHash: string
  createdAt: Date
}

export interface ProcessingTaxonomySnapshotRecord {
  id: string
  userId: string
  name: string
  version: number
  content: Record<string, unknown>
  contentHash: string
  createdAt: Date
}

export type ProcessingJobStatus = "queued" | "running" | "succeeded" | "failed" | "superseded"

export interface ProcessingJobRecord {
  id: string
  userId: string
  entryId: string
  purpose: "entry_evaluation"
  processorName: string
  processorVersion: string
  scoreFormulaVersion: string
  profileSnapshotId: string
  taxonomySnapshotId: string
  contentFingerprint: string
  status: ProcessingJobStatus
  priority: number
  attemptCount: number
  queuedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  nextRetryAt: Date | null
  lastErrorCode: string | null
  lastErrorSummary: string | null
  idempotencyKey: string
  forceRerun: boolean
  supersededByJobId: string | null
}

export interface ProcessingAttemptRecord {
  id: string
  jobId: string
  attemptNumber: number
  status: "running" | "succeeded" | "failed"
  startedAt: Date
  finishedAt: Date | null
  errorSummary: string | null
  executionMetadata: Record<string, unknown> | null
}

export interface EntryEvaluationRecord {
  id: string
  entryId: string
  importanceScore: number
  timelinessScore: number
  relevanceScore: number
  overallScore: number
  recommendationReason: string
  primaryCategory: string
  secondaryCategory: string | null
  tags: string[]
  processorType: "ai"
  processorName: string
  processorVersion: string
  scoreFormulaVersion: string
  profileSnapshotId: string
  taxonomySnapshotId: string
  contentFingerprint: string
  processedAt: Date
  details: Record<string, unknown> | null
}

export interface EntryProjectionRecord {
  evaluation: EntryEvaluationRecord | null
  processingJob: ProcessingJobRecord | null
}

export interface EntrySummaryRecord {
  entryId: string
  language: string
  target: "content" | "readabilityContent"
  summary: string
  model: string
  createdAt: Date
}

export interface EntryTranslationRecord {
  entryId: string
  language: string
  title: string | null
  description: string | null
  content: string | null
  readabilityContent: string | null
  model: string
  createdAt: Date
}

export interface ActionRulesRecord {
  userId: string
  rules: Array<Record<string, unknown>>
  createdAt: Date
  updatedAt: Date
}

export type EnqueueProcessingJobResult =
  | { outcome: "created"; job: ProcessingJobRecord; supersededCount: number }
  | { outcome: "reused"; job: ProcessingJobRecord }
  | { outcome: "failed_requires_retry"; job: ProcessingJobRecord }
  | { outcome: "already_satisfied"; evaluation: EntryEvaluationRecord }

/** The Folo client's task schedule; times are ISO instants whose wall-clock part is the owner's. */
export type AITaskSchedule =
  | { type: "once"; date: string }
  | { type: "daily"; timeOfDay: string }
  | { type: "weekly"; dayOfWeek: number; timeOfDay: string }
  | { type: "monthly"; dayOfMonth: number; timeOfDay: string }

export interface AITaskRecord {
  id: string
  userId: string
  name: string
  /** Serialized editor state from the client, or plain text */
  prompt: string
  isEnabled: boolean
  schedule: AITaskSchedule
  options: { notifyChannels: string[] }
  /** null once a one-off task has run or when the schedule has no further slot */
  nextRunAt: Date | null
  lastRunAt: Date | null
  runCount: number
  lastResult: string | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

export type AITaskPatch = Partial<
  Pick<
    AITaskRecord,
    "isEnabled" | "name" | "nextRunAt" | "options" | "prompt" | "schedule" | "updatedAt"
  >
>

export type AITaskRunKind = "scheduled" | "test"
export type AITaskRunStatus = "failed" | "queued" | "running" | "skipped" | "succeeded"

export interface AITaskRunRecord {
  id: string
  taskId: string
  userId: string
  kind: AITaskRunKind
  /** The schedule slot; the start time for test runs */
  scheduledFor: Date
  windowStart: Date
  windowEnd: Date
  status: AITaskRunStatus
  attemptCount: number
  nextAttemptAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  candidateCount: number | null
  selectedCount: number | null
  unevaluatedCount: number | null
  errorCode: string | null
  errorSummary: string | null
  usage: Record<string, unknown> | null
  sessionId: string | null
  createdAt: Date
}

export interface AIChatSessionRecord {
  chatId: string
  userId: string
  title: string
  createdAt: Date
  updatedAt: Date
  lastSeenAt: Date
}

export interface AIChatMessageRecord {
  id: string
  chatId: string
  role: "assistant" | "system" | "user"
  messageParts: Array<Record<string, unknown>>
  metadata: Record<string, unknown> | null
  status: "completed" | "error" | "pending"
  createdAt: Date
  finishedAt: Date | null
}

/** A report written by a finished run, stored with the run in one transaction. */
export interface AITaskRunCompletion {
  run: AITaskRunRecord
  session: AIChatSessionRecord
  message: AIChatMessageRecord
  task: {
    id: string
    lastRunAt: Date
    lastResult: string | null
    lastError: string | null
    /** Scheduled runs count towards `runCount`; test runs do not. */
    countRun: boolean
  }
}

export interface BriefingCandidateRecord {
  entry: EntryRecord
  evaluation: EntryEvaluationRecord
  feedTitle: string | null
  subscription: SubscriptionRecord
  summary: string | null
}

export interface BriefingCandidateQuery {
  userId: string
  insertedAfter: Date
  insertedBefore: Date
  minimumScore: number
}

export type SettingsTab = "ai" | "appearance" | "general" | "integration"
export interface SettingsRecord {
  payload: Record<string, unknown>
  updatedAt: Date
}

export interface DataStore {
  getOwnerUserId(): Promise<string | null>
  claimOwner(userId: string): Promise<string>
  saveFeed(
    feed: FeedRecord,
    entries: EntryRecord[],
    attempt?: FeedFetchAttemptRecord,
  ): Promise<void>
  createSubscription(subscription: SubscriptionRecord): Promise<void>
  updateSubscription(
    userId: string,
    feedId: string,
    patch: SubscriptionPatch,
  ): Promise<SubscriptionRecord | null>
  deleteSubscriptions(userId: string, feedIds: string[]): Promise<void>
  listSubscriptions(userId: string, view?: number): Promise<SubscriptionRecord[]>
  getSubscription(userId: string, feedId: string): Promise<SubscriptionRecord | null>
  createList(list: ListRecord, subscription: ListSubscriptionRecord): Promise<void>
  updateList(userId: string, listId: string, patch: ListPatch): Promise<ListRecord | null>
  deleteList(userId: string, listId: string): Promise<void>
  getList(userId: string, listId: string): Promise<ListRecord | null>
  listLists(userId: string): Promise<ListRecord[]>
  setListFeeds(userId: string, listId: string, feedIds: string[]): Promise<ListRecord | null>
  listListSubscriptions(userId: string, view?: number): Promise<ListSubscriptionRecord[]>
  updateListSubscription(
    userId: string,
    listId: string,
    patch: SubscriptionPatch,
  ): Promise<ListSubscriptionRecord | null>
  deleteListSubscription(userId: string, listId: string): Promise<void>
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
  getReadability(userId: string, entryId: string): Promise<ReadabilityRecord | null>
  setReadability(userId: string, entryId: string, content: string): Promise<void>
  getAIProviderConfig(userId: string): Promise<AIProviderConfigRecord | null>
  setAIProviderConfig(config: AIProviderConfigRecord): Promise<void>
  deleteAIProviderConfig(userId: string): Promise<void>
  createProcessingProfileSnapshot(
    snapshot: ProcessingProfileSnapshotRecord,
  ): Promise<ProcessingProfileSnapshotRecord>
  listProcessingProfileSnapshots(userId: string): Promise<ProcessingProfileSnapshotRecord[]>
  getProcessingProfileSnapshot(
    userId: string,
    snapshotId: string,
  ): Promise<ProcessingProfileSnapshotRecord | null>
  createProcessingTaxonomySnapshot(
    snapshot: ProcessingTaxonomySnapshotRecord,
  ): Promise<ProcessingTaxonomySnapshotRecord>
  listProcessingTaxonomySnapshots(userId: string): Promise<ProcessingTaxonomySnapshotRecord[]>
  getProcessingTaxonomySnapshot(
    userId: string,
    snapshotId: string,
  ): Promise<ProcessingTaxonomySnapshotRecord | null>
  enqueueProcessingJob(job: ProcessingJobRecord): Promise<EnqueueProcessingJobResult>
  claimNextProcessingJob(now: Date): Promise<ProcessingJobRecord | null>
  getProcessingJob(userId: string, jobId: string): Promise<ProcessingJobRecord | null>
  listFailedProcessingJobs(userId: string, limit: number): Promise<ProcessingJobRecord[]>
  listProcessingAttempts(userId: string, jobId: string): Promise<ProcessingAttemptRecord[]>
  getEntryProcessingJobs(userId: string, entryId: string): Promise<ProcessingJobRecord[]>
  getEntryProjections(
    userId: string,
    entryIds: string[],
  ): Promise<Record<string, EntryProjectionRecord>>
  completeProcessingJob(input: {
    attempt: ProcessingAttemptRecord
    evaluation: EntryEvaluationRecord
    jobId: string
  }): Promise<void>
  failProcessingJob(input: {
    attempt: ProcessingAttemptRecord
    errorCode: string
    errorSummary: string
    jobId: string
    nextRetryAt: Date | null
  }): Promise<void>
  retryProcessingJob(userId: string, jobId: string): Promise<ProcessingJobRecord | null>
  getCurrentEntryEvaluation(userId: string, entryId: string): Promise<EntryEvaluationRecord | null>
  listEntryEvaluations(userId: string, entryId: string): Promise<EntryEvaluationRecord[]>
  selectEntryEvaluation(
    userId: string,
    entryId: string,
    evaluationId: string,
    reason: string,
  ): Promise<EntryEvaluationRecord | null>
  getEntrySummary(
    userId: string,
    entryId: string,
    language: string,
    target: EntrySummaryRecord["target"],
  ): Promise<EntrySummaryRecord | null>
  setEntrySummary(userId: string, summary: EntrySummaryRecord): Promise<void>
  getEntryTranslation(
    userId: string,
    entryId: string,
    language: string,
  ): Promise<EntryTranslationRecord | null>
  setEntryTranslation(userId: string, translation: EntryTranslationRecord): Promise<void>
  getActionRules(userId: string): Promise<ActionRulesRecord | null>
  setActionRules(userId: string, rules: Array<Record<string, unknown>>): Promise<void>
  /** Writes only if the stored rules still have `expectedUpdatedAt` (null: none stored yet). */
  setActionRulesIfUnchanged(
    userId: string,
    rules: Array<Record<string, unknown>>,
    expectedUpdatedAt: Date | null,
  ): Promise<boolean>
  cleanupProcessingHistory(now: Date): Promise<MaintenanceCleanupReport>
  getUnreadCounts(userId: string, view?: number): Promise<Record<string, number>>
  getUnreadSnapshot(userId: string, view?: number): Promise<UnreadSnapshot>
  /** The newest sync id recorded for the user, 0 when nothing was logged yet */
  getSyncState(userId: string): Promise<number>
  listSyncActions(userId: string, afterId: number, limit: number): Promise<SyncDelta>
  /** Deletes log rows past retention; part of the daily maintenance cleanup. */
  cleanupSyncActions(now: Date): Promise<number>
  setEntriesRead(userId: string, entryIds: string[], read: boolean): Promise<void>
  markAllAsRead(userId: string, filter: MarkAllReadFilter): Promise<Record<string, number>>
  isEntryCollected(userId: string, entryId: string): Promise<boolean>
  setEntryCollected(userId: string, entryId: string, collected: boolean): Promise<void>
  listSubscribedFeeds(): Promise<FeedRecord[]>
  listFeedFetchAttempts(feedId: string, limit: number): Promise<FeedFetchAttemptRecord[]>
  checkHealth(): Promise<void>
  getOperationalStats(now: Date): Promise<OperationalStats>
  listAITasks(userId: string): Promise<AITaskRecord[]>
  getAITask(userId: string, taskId: string): Promise<AITaskRecord | null>
  createAITask(task: AITaskRecord): Promise<void>
  updateAITask(userId: string, taskId: string, patch: AITaskPatch): Promise<AITaskRecord | null>
  deleteAITask(userId: string, taskId: string): Promise<boolean>
  listDueAITasks(now: Date, limit: number): Promise<AITaskRecord[]>
  /**
   * Records the run for the slot the task is due at (`run.scheduledFor`) and moves the task to
   * `nextRunAt`. Returns false without writing when the task is no longer due at that slot or the
   * slot already has a run, so concurrent workers schedule each slot once.
   */
  scheduleAITaskRun(run: AITaskRunRecord, nextRunAt: Date | null): Promise<boolean>
  createAITaskRun(run: AITaskRunRecord): Promise<void>
  /** Queued runs whose attempt is due and running runs started before `staleBefore`. */
  listRunnableAITaskRuns(now: Date, staleBefore: Date, limit: number): Promise<AITaskRunRecord[]>
  /** Marks a runnable run as running and counts the attempt; null when it is not runnable. */
  claimAITaskRun(runId: string, now: Date, staleBefore: Date): Promise<AITaskRunRecord | null>
  /** The latest scheduled run of the task for a slot before `before`. */
  getPreviousAITaskRun(taskId: string, before: Date): Promise<AITaskRunRecord | null>
  updateAITaskRun(run: AITaskRunRecord): Promise<void>
  /** Stores the run's final state, its report session and the task's last result together. */
  completeAITaskRun(completion: AITaskRunCompletion): Promise<void>
  listBriefingCandidates(query: BriefingCandidateQuery): Promise<{
    candidates: BriefingCandidateRecord[]
    /** Entries in the window that have no current evaluation yet */
    unevaluatedCount: number
  }>
  /** Newest first by `updatedAt`, strictly before `before` when given */
  listAIChatSessions(
    userId: string,
    page: { before?: Date; limit: number },
  ): Promise<{ sessions: AIChatSessionRecord[]; total: number }>
  getAIChatSession(userId: string, chatId: string): Promise<AIChatSessionRecord | null>
  /** Newest first by `createdAt`, strictly before `before` when given */
  listAIChatMessages(
    userId: string,
    chatId: string,
    page: { before?: Date; limit: number },
  ): Promise<AIChatMessageRecord[]>
  updateAIChatSession(
    userId: string,
    chatId: string,
    patch: Partial<Pick<AIChatSessionRecord, "lastSeenAt" | "title">>,
  ): Promise<AIChatSessionRecord | null>
  deleteAIChatSession(userId: string, chatId: string): Promise<boolean>
  listUnreadAIChatSessionIds(userId: string, limit: number): Promise<string[]>
  getSettings(userId: string): Promise<Partial<Record<SettingsTab, SettingsRecord>>>
  /** Merges the given keys into the stored tab; clients send only the keys that changed. */
  setSettings(userId: string, tab: SettingsTab, payload: Record<string, unknown>): Promise<void>
}
