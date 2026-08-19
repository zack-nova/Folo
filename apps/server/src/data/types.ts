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
  cleanupProcessingHistory(now: Date): Promise<MaintenanceCleanupReport>
  getUnreadCounts(userId: string, view?: number): Promise<Record<string, number>>
  setEntriesRead(userId: string, entryIds: string[], read: boolean): Promise<void>
  markAllAsRead(userId: string, filter: MarkAllReadFilter): Promise<Record<string, number>>
  isEntryCollected(userId: string, entryId: string): Promise<boolean>
  setEntryCollected(userId: string, entryId: string, collected: boolean): Promise<void>
  listSubscribedFeeds(): Promise<FeedRecord[]>
  listFeedFetchAttempts(feedId: string, limit: number): Promise<FeedFetchAttemptRecord[]>
  checkHealth(): Promise<void>
  getOperationalStats(now: Date): Promise<OperationalStats>
  getSettings(userId: string): Promise<Partial<Record<SettingsTab, SettingsRecord>>>
  setSettings(userId: string, tab: SettingsTab, payload: Record<string, unknown>): Promise<void>
}
