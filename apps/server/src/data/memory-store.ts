import {
  actionRulesUpdated,
  collectionDeleted,
  collectionInserted,
  listDeleted,
  listSubscriptionDeleted,
  listSubscriptionInserted,
  listSubscriptionUpdated,
  listUpdated,
  settingsUpdated,
  subscriptionDeleted,
  subscriptionInserted,
  subscriptionUpdated,
  SYNC_ACTION_RETENTION_MS,
  SYNC_HINT_RETENTION_MS,
  timelineEntriesArrived,
  timelineReadFlipped,
} from "../sync/actions"
import type {
  ActionRulesRecord,
  AIProviderConfigRecord,
  DataStore,
  EnqueueProcessingJobResult,
  EntryEvaluationRecord,
  EntryListFilter,
  EntryProjectionRecord,
  EntryRecord,
  EntrySummaryRecord,
  EntryTranslationRecord,
  FeedFetchAttemptRecord,
  FeedRecord,
  ListPatch,
  ListRecord,
  ListSubscriptionRecord,
  MaintenanceCleanupReport,
  MarkAllReadFilter,
  OperationalStats,
  ProcessingAttemptRecord,
  ProcessingJobRecord,
  ProcessingProfileSnapshotRecord,
  ProcessingTaxonomySnapshotRecord,
  ReadabilityRecord,
  SettingsRecord,
  SettingsTab,
  SubscriptionPatch,
  SubscriptionRecord,
  SyncActionInput,
  SyncActionRecord,
  SyncDelta,
  UnreadSnapshot,
} from "./types"

const subscriptionKey = (userId: string, feedId: string) => `${userId}:${feedId}`
const readKey = (userId: string, entryId: string) => `${userId}:${entryId}`
const collectionKey = (userId: string, entryId: string) => `${userId}:${entryId}`
const listSubscriptionKey = (userId: string, listId: string) => `${userId}:${listId}`

export class MemoryDataStore implements DataStore {
  private readonly actionRules = new Map<string, ActionRulesRecord>()
  private readonly aiProviderConfigs = new Map<string, AIProviderConfigRecord>()
  private readonly collections = new Map<string, Date>()
  private readonly entries = new Map<string, EntryRecord>()
  private readonly entryCurrentEvaluations = new Map<string, string>()
  private readonly entryEvaluations = new Map<string, EntryEvaluationRecord>()
  private readonly entrySummaries = new Map<string, EntrySummaryRecord>()
  private readonly entryTranslations = new Map<string, EntryTranslationRecord>()
  private readonly feeds = new Map<string, FeedRecord>()
  private readonly feedFetchAttempts = new Map<string, FeedFetchAttemptRecord>()
  private readonly lists = new Map<string, ListRecord>()
  private readonly listSubscriptionRecords = new Map<string, ListSubscriptionRecord>()
  private readonly reads = new Set<string>()
  private readonly readability = new Map<string, ReadabilityRecord>()
  private readonly settings = new Map<string, SettingsRecord>()
  private readonly subscriptions = new Map<string, SubscriptionRecord>()
  private readonly processingAttempts = new Map<string, ProcessingAttemptRecord>()
  private readonly processingJobs = new Map<string, ProcessingJobRecord>()
  private readonly processingProfiles = new Map<string, ProcessingProfileSnapshotRecord>()
  private readonly processingTaxonomies = new Map<string, ProcessingTaxonomySnapshotRecord>()
  private ownerUserId: string | null = null
  private readonly syncLog: SyncActionRecord[] = []
  private readonly syncFloors = new Map<string, number>()
  private nextSyncId = 1

  private recordSyncActions(actions: SyncActionInput[]) {
    for (const action of actions) {
      this.syncLog.push({
        ...structuredClone(action),
        id: this.nextSyncId++,
        createdAt: new Date(),
      })
    }
  }

  async getOwnerUserId(): Promise<string | null> {
    return this.ownerUserId
  }

  async claimOwner(userId: string): Promise<string> {
    this.ownerUserId ??= userId
    return this.ownerUserId
  }

  async saveFeed(
    feed: FeedRecord,
    entries: EntryRecord[],
    attempt?: FeedFetchAttemptRecord,
  ): Promise<void> {
    this.feeds.set(feed.id, structuredClone(feed))
    const inserted: EntryRecord[] = []
    for (const entry of entries) {
      const existing = this.entries.get(entry.id)
      const saved = structuredClone(entry)
      if (!existing) inserted.push(saved)
      if (existing) {
        saved.insertedAt = existing.insertedAt
        if (entry.publishedAt.getTime() === entry.insertedAt.getTime()) {
          saved.publishedAt = existing.publishedAt
        }
      }
      this.entries.set(entry.id, saved)
    }
    if (attempt) {
      this.feedFetchAttempts.set(attempt.id, structuredClone(attempt))
      const stale = [...this.feedFetchAttempts.values()]
        .filter((candidate) => candidate.feedId === attempt.feedId)
        .sort((left, right) => right.finishedAt.getTime() - left.finishedAt.getTime())
        .slice(500)
      for (const candidate of stale) this.feedFetchAttempts.delete(candidate.id)
    }
    if (inserted.length === 0) return
    for (const subscription of this.subscriptions.values()) {
      if (subscription.feedId !== feed.id) continue
      const listIds = [...this.lists.values()]
        .filter(
          (list) => list.ownerUserId === subscription.userId && list.feedIds.includes(feed.id),
        )
        .map((list) => list.id)
      this.recordSyncActions([
        timelineEntriesArrived(subscription.userId, feed.id, inserted, listIds),
      ])
    }
  }

  async createSubscription(subscription: SubscriptionRecord): Promise<void> {
    this.subscriptions.set(
      subscriptionKey(subscription.userId, subscription.feedId),
      structuredClone(subscription),
    )
    const feed = this.feeds.get(subscription.feedId)
    if (feed) this.recordSyncActions([subscriptionInserted(subscription, feed)])
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
    this.recordSyncActions([subscriptionUpdated(userId, feedId, patch)])
    return structuredClone(updated)
  }

  async deleteSubscriptions(userId: string, feedIds: string[]): Promise<void> {
    for (const feedId of new Set(feedIds)) {
      if (this.subscriptions.delete(subscriptionKey(userId, feedId))) {
        this.recordSyncActions([subscriptionDeleted(userId, feedId)])
      }
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

  async createList(list: ListRecord, subscription: ListSubscriptionRecord): Promise<void> {
    this.lists.set(list.id, structuredClone(list))
    this.listSubscriptionRecords.set(
      listSubscriptionKey(subscription.userId, subscription.listId),
      structuredClone(subscription),
    )
    this.recordSyncActions([listSubscriptionInserted(subscription, list)])
  }

  async updateList(userId: string, listId: string, patch: ListPatch): Promise<ListRecord | null> {
    const current = await this.getList(userId, listId)
    if (!current) return null
    const updated = { ...current, ...structuredClone(patch), updatedAt: new Date() }
    this.lists.set(listId, updated)
    this.recordSyncActions([listUpdated(userId, listId, patch)])
    if (patch.view !== undefined) {
      await this.updateListSubscription(userId, listId, { view: patch.view })
    }
    return structuredClone(updated)
  }

  async deleteList(userId: string, listId: string): Promise<void> {
    const list = await this.getList(userId, listId)
    if (!list) return
    this.lists.delete(listId)
    const userIds = new Set([userId])
    for (const [key, subscription] of this.listSubscriptionRecords) {
      if (subscription.listId !== listId) continue
      this.listSubscriptionRecords.delete(key)
      userIds.add(subscription.userId)
    }
    // Clients drop their subscription to the list along with it.
    this.recordSyncActions([...userIds].map((id) => listDeleted(id, listId)))
  }

  async getList(userId: string, listId: string): Promise<ListRecord | null> {
    const list = this.lists.get(listId)
    return list?.ownerUserId === userId ? structuredClone(list) : null
  }

  async listLists(userId: string): Promise<ListRecord[]> {
    return [...this.lists.values()]
      .filter((list) => list.ownerUserId === userId)
      .map((list) => structuredClone(list))
  }

  async setListFeeds(
    userId: string,
    listId: string,
    feedIds: string[],
  ): Promise<ListRecord | null> {
    const list = await this.getList(userId, listId)
    if (!list) return null
    const updated = { ...list, feedIds: [...new Set(feedIds)], updatedAt: new Date() }
    this.lists.set(listId, updated)
    this.recordSyncActions([listUpdated(userId, listId, { feedIds: updated.feedIds })])
    return structuredClone(updated)
  }

  async listListSubscriptions(userId: string, view?: number): Promise<ListSubscriptionRecord[]> {
    return [...this.listSubscriptionRecords.values()]
      .filter(
        (subscription) =>
          subscription.userId === userId && (view === undefined || subscription.view === view),
      )
      .map((subscription) => structuredClone(subscription))
  }

  async updateListSubscription(
    userId: string,
    listId: string,
    patch: SubscriptionPatch,
  ): Promise<ListSubscriptionRecord | null> {
    const key = listSubscriptionKey(userId, listId)
    const current = this.listSubscriptionRecords.get(key)
    if (!current) return null
    const updated = { ...current, ...structuredClone(patch) }
    this.listSubscriptionRecords.set(key, updated)
    this.recordSyncActions([listSubscriptionUpdated(userId, listId, patch)])
    return structuredClone(updated)
  }

  async deleteListSubscription(userId: string, listId: string): Promise<void> {
    if (this.listSubscriptionRecords.delete(listSubscriptionKey(userId, listId))) {
      this.recordSyncActions([listSubscriptionDeleted(userId, listId)])
    }
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
    sortOrder,
    limit,
  }: EntryListFilter): Promise<
    Array<{
      entry: EntryRecord
      subscription: SubscriptionRecord
      read: boolean
      collectionCreatedAt: Date | null
    }>
  > {
    const orderTime = (entry: EntryRecord) =>
      isCollection === true
        ? this.collections.get(collectionKey(userId, entry.id))!.getTime()
        : entry.publishedAt.getTime()
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
        (entry) => publishedAfter === undefined || orderTime(entry) > publishedAfter.getTime(),
      )
      .filter(
        (entry) => publishedBefore === undefined || orderTime(entry) < publishedBefore.getTime(),
      )
      .sort((left, right) =>
        sortOrder === "asc"
          ? orderTime(left) - orderTime(right)
          : orderTime(right) - orderTime(left),
      )
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

  async getReadability(userId: string, entryId: string): Promise<ReadabilityRecord | null> {
    if (!(await this.getEntry(userId, entryId))) return null
    const record = this.readability.get(entryId)
    return record ? structuredClone(record) : null
  }

  async setReadability(userId: string, entryId: string, content: string): Promise<void> {
    if (!(await this.getEntry(userId, entryId))) return
    this.readability.set(entryId, { content, entryId, updatedAt: new Date() })
  }

  async getAIProviderConfig(userId: string): Promise<AIProviderConfigRecord | null> {
    const config = this.aiProviderConfigs.get(userId)
    return config ? structuredClone(config) : null
  }

  async setAIProviderConfig(config: AIProviderConfigRecord): Promise<void> {
    this.aiProviderConfigs.set(config.userId, structuredClone(config))
  }

  async deleteAIProviderConfig(userId: string): Promise<void> {
    this.aiProviderConfigs.delete(userId)
  }

  async createProcessingProfileSnapshot(
    snapshot: ProcessingProfileSnapshotRecord,
  ): Promise<ProcessingProfileSnapshotRecord> {
    this.processingProfiles.set(snapshot.id, structuredClone(snapshot))
    return structuredClone(snapshot)
  }

  async listProcessingProfileSnapshots(userId: string): Promise<ProcessingProfileSnapshotRecord[]> {
    return [...this.processingProfiles.values()]
      .filter((snapshot) => snapshot.userId === userId)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.version - left.version,
      )
      .map((snapshot) => structuredClone(snapshot))
  }

  async getProcessingProfileSnapshot(
    userId: string,
    snapshotId: string,
  ): Promise<ProcessingProfileSnapshotRecord | null> {
    const snapshot = this.processingProfiles.get(snapshotId)
    return snapshot?.userId === userId ? structuredClone(snapshot) : null
  }

  async createProcessingTaxonomySnapshot(
    snapshot: ProcessingTaxonomySnapshotRecord,
  ): Promise<ProcessingTaxonomySnapshotRecord> {
    this.processingTaxonomies.set(snapshot.id, structuredClone(snapshot))
    return structuredClone(snapshot)
  }

  async listProcessingTaxonomySnapshots(
    userId: string,
  ): Promise<ProcessingTaxonomySnapshotRecord[]> {
    return [...this.processingTaxonomies.values()]
      .filter((snapshot) => snapshot.userId === userId)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.version - left.version,
      )
      .map((snapshot) => structuredClone(snapshot))
  }

  async getProcessingTaxonomySnapshot(
    userId: string,
    snapshotId: string,
  ): Promise<ProcessingTaxonomySnapshotRecord | null> {
    const snapshot = this.processingTaxonomies.get(snapshotId)
    return snapshot?.userId === userId ? structuredClone(snapshot) : null
  }

  async enqueueProcessingJob(job: ProcessingJobRecord): Promise<EnqueueProcessingJobResult> {
    if (!job.forceRerun) {
      const current = await this.getCurrentEntryEvaluation(job.userId, job.entryId)
      if (
        current &&
        current.contentFingerprint === job.contentFingerprint &&
        current.processorName === job.processorName &&
        current.processorVersion === job.processorVersion &&
        current.scoreFormulaVersion === job.scoreFormulaVersion &&
        current.profileSnapshotId === job.profileSnapshotId &&
        current.taxonomySnapshotId === job.taxonomySnapshotId
      ) {
        return { evaluation: current, outcome: "already_satisfied" }
      }
    }

    const active = [...this.processingJobs.values()].find(
      (candidate) =>
        candidate.idempotencyKey === job.idempotencyKey &&
        (candidate.status === "queued" || candidate.status === "running"),
    )
    if (active) {
      if (active.status === "queued" && job.priority > active.priority) {
        active.priority = job.priority
      }
      return { job: structuredClone(active), outcome: "reused" }
    }

    let supersededCount = 0
    for (const candidate of this.processingJobs.values()) {
      if (
        candidate.userId === job.userId &&
        candidate.entryId === job.entryId &&
        candidate.purpose === job.purpose &&
        candidate.status === "queued"
      ) {
        candidate.status = "superseded"
        candidate.finishedAt = new Date()
        candidate.supersededByJobId = job.id
        supersededCount += 1
      }
    }
    this.processingJobs.set(job.id, structuredClone(job))
    return { job: structuredClone(job), outcome: "created", supersededCount }
  }

  async claimNextProcessingJob(now: Date): Promise<ProcessingJobRecord | null> {
    const runningEntries = new Set(
      [...this.processingJobs.values()]
        .filter((job) => job.status === "running")
        .map((job) => job.entryId),
    )
    const job = [...this.processingJobs.values()]
      .filter(
        (candidate) =>
          candidate.status === "queued" &&
          !runningEntries.has(candidate.entryId) &&
          (!candidate.nextRetryAt || candidate.nextRetryAt <= now),
      )
      .sort(
        (left, right) =>
          right.priority - left.priority || left.queuedAt.getTime() - right.queuedAt.getTime(),
      )
      .at(0)
    if (!job) return null
    job.status = "running"
    job.startedAt = now
    job.attemptCount += 1
    return structuredClone(job)
  }

  async getProcessingJob(userId: string, jobId: string): Promise<ProcessingJobRecord | null> {
    const job = this.processingJobs.get(jobId)
    return job?.userId === userId ? structuredClone(job) : null
  }

  async listFailedProcessingJobs(userId: string, limit: number): Promise<ProcessingJobRecord[]> {
    return [...this.processingJobs.values()]
      .filter((job) => job.userId === userId && job.status === "failed")
      .sort((left, right) => (right.finishedAt?.getTime() ?? 0) - (left.finishedAt?.getTime() ?? 0))
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map((job) => structuredClone(job))
  }

  async listProcessingAttempts(userId: string, jobId: string): Promise<ProcessingAttemptRecord[]> {
    const job = await this.getProcessingJob(userId, jobId)
    if (!job) return []
    return [...this.processingAttempts.values()]
      .filter((attempt) => attempt.jobId === jobId)
      .sort((left, right) => left.attemptNumber - right.attemptNumber)
      .map((attempt) => structuredClone(attempt))
  }

  async getEntryProcessingJobs(userId: string, entryId: string): Promise<ProcessingJobRecord[]> {
    if (!(await this.getEntry(userId, entryId))) return []
    return [...this.processingJobs.values()]
      .filter((job) => job.userId === userId && job.entryId === entryId)
      .sort((left, right) => {
        const active = (status: ProcessingJobRecord["status"]) =>
          status === "queued" || status === "running" ? 1 : 0
        return (
          active(right.status) - active(left.status) ||
          right.queuedAt.getTime() - left.queuedAt.getTime()
        )
      })
      .map((job) => structuredClone(job))
  }

  async getEntryProjections(
    userId: string,
    entryIds: string[],
  ): Promise<Record<string, EntryProjectionRecord>> {
    const allowedFeedIds = new Set(
      [...this.subscriptions.values()]
        .filter((subscription) => subscription.userId === userId)
        .map((subscription) => subscription.feedId),
    )
    const result: Record<string, EntryProjectionRecord> = {}
    for (const entryId of new Set(entryIds)) {
      const entry = this.entries.get(entryId)
      if (!entry || !allowedFeedIds.has(entry.feedId)) {
        result[entryId] = { evaluation: null, processingJob: null }
        continue
      }
      const evaluationId = this.entryCurrentEvaluations.get(entryId)
      const evaluation = evaluationId ? this.entryEvaluations.get(evaluationId) : undefined
      const processingJob = [...this.processingJobs.values()]
        .filter((job) => job.userId === userId && job.entryId === entryId)
        .sort((left, right) => {
          const active = (status: ProcessingJobRecord["status"]) =>
            status === "queued" || status === "running" ? 1 : 0
          return (
            active(right.status) - active(left.status) ||
            right.queuedAt.getTime() - left.queuedAt.getTime()
          )
        })
        .at(0)
      result[entryId] = {
        evaluation: evaluation ? structuredClone(evaluation) : null,
        processingJob: processingJob ? structuredClone(processingJob) : null,
      }
    }
    return result
  }

  async completeProcessingJob(input: {
    attempt: ProcessingAttemptRecord
    evaluation: EntryEvaluationRecord
    jobId: string
  }): Promise<void> {
    const job = this.processingJobs.get(input.jobId)
    if (!job || job.status !== "running") return
    this.entryEvaluations.set(input.evaluation.id, structuredClone(input.evaluation))
    this.entryCurrentEvaluations.set(input.evaluation.entryId, input.evaluation.id)
    this.processingAttempts.set(input.attempt.id, structuredClone(input.attempt))
    job.status = "succeeded"
    job.finishedAt = input.attempt.finishedAt ?? new Date()
    job.nextRetryAt = null
    job.lastErrorCode = null
    job.lastErrorSummary = null
  }

  async failProcessingJob(input: {
    attempt: ProcessingAttemptRecord
    errorCode: string
    errorSummary: string
    jobId: string
    nextRetryAt: Date | null
  }): Promise<void> {
    const job = this.processingJobs.get(input.jobId)
    if (!job) return
    this.processingAttempts.set(input.attempt.id, structuredClone(input.attempt))
    job.status = input.nextRetryAt ? "queued" : "failed"
    job.finishedAt = input.nextRetryAt ? null : (input.attempt.finishedAt ?? new Date())
    job.nextRetryAt = input.nextRetryAt
    job.lastErrorCode = input.errorCode
    job.lastErrorSummary = input.errorSummary
  }

  async retryProcessingJob(userId: string, jobId: string): Promise<ProcessingJobRecord | null> {
    const job = this.processingJobs.get(jobId)
    if (!job || job.userId !== userId || job.status !== "failed") return null
    job.status = "queued"
    job.finishedAt = null
    job.nextRetryAt = null
    job.lastErrorCode = null
    job.lastErrorSummary = null
    return structuredClone(job)
  }

  async getCurrentEntryEvaluation(
    userId: string,
    entryId: string,
  ): Promise<EntryEvaluationRecord | null> {
    if (!(await this.getEntry(userId, entryId))) return null
    const evaluationId = this.entryCurrentEvaluations.get(entryId)
    const evaluation = evaluationId ? this.entryEvaluations.get(evaluationId) : null
    return evaluation ? structuredClone(evaluation) : null
  }

  async listEntryEvaluations(userId: string, entryId: string): Promise<EntryEvaluationRecord[]> {
    if (!(await this.getEntry(userId, entryId))) return []
    return [...this.entryEvaluations.values()]
      .filter((evaluation) => evaluation.entryId === entryId)
      .sort((left, right) => right.processedAt.getTime() - left.processedAt.getTime())
      .map((evaluation) => structuredClone(evaluation))
  }

  async selectEntryEvaluation(
    userId: string,
    entryId: string,
    evaluationId: string,
    _reason: string,
  ): Promise<EntryEvaluationRecord | null> {
    if (!(await this.getEntry(userId, entryId))) return null
    const evaluation = this.entryEvaluations.get(evaluationId)
    if (!evaluation || evaluation.entryId !== entryId) return null
    this.entryCurrentEvaluations.set(entryId, evaluationId)
    return structuredClone(evaluation)
  }

  async getEntrySummary(
    userId: string,
    entryId: string,
    language: string,
    target: EntrySummaryRecord["target"],
  ): Promise<EntrySummaryRecord | null> {
    if (!(await this.getEntry(userId, entryId))) return null
    const summary = this.entrySummaries.get(`${entryId}:${language}:${target}`)
    return summary ? structuredClone(summary) : null
  }

  async setEntrySummary(userId: string, summary: EntrySummaryRecord): Promise<void> {
    if (!(await this.getEntry(userId, summary.entryId))) return
    this.entrySummaries.set(
      `${summary.entryId}:${summary.language}:${summary.target}`,
      structuredClone(summary),
    )
  }

  async getEntryTranslation(
    userId: string,
    entryId: string,
    language: string,
  ): Promise<EntryTranslationRecord | null> {
    if (!(await this.getEntry(userId, entryId))) return null
    const translation = this.entryTranslations.get(`${entryId}:${language}`)
    return translation ? structuredClone(translation) : null
  }

  async setEntryTranslation(userId: string, translation: EntryTranslationRecord): Promise<void> {
    if (!(await this.getEntry(userId, translation.entryId))) return
    this.entryTranslations.set(
      `${translation.entryId}:${translation.language}`,
      structuredClone(translation),
    )
  }

  async getActionRules(userId: string): Promise<ActionRulesRecord | null> {
    const rules = this.actionRules.get(userId)
    return rules ? structuredClone(rules) : null
  }

  async setActionRules(userId: string, rules: Array<Record<string, unknown>>): Promise<void> {
    const current = this.actionRules.get(userId)
    const now = new Date()
    this.actionRules.set(userId, {
      createdAt: current?.createdAt ?? now,
      rules: structuredClone(rules),
      updatedAt: now,
      userId,
    })
    this.recordSyncActions([actionRulesUpdated(userId, rules)])
  }

  async cleanupSyncActions(now: Date): Promise<number> {
    let deleted = 0
    for (let index = this.syncLog.length - 1; index >= 0; index--) {
      const action = this.syncLog[index]!
      const age = now.getTime() - action.createdAt.getTime()
      const isHint = action.action === "N"
      if (age <= (isHint ? SYNC_HINT_RETENTION_MS : SYNC_ACTION_RETENTION_MS)) continue
      this.syncLog.splice(index, 1)
      deleted += 1
      if (!isHint) {
        this.syncFloors.set(
          action.userId,
          Math.max(this.syncFloors.get(action.userId) ?? 0, action.id),
        )
      }
    }
    return deleted
  }

  async cleanupProcessingHistory(now: Date): Promise<MaintenanceCleanupReport> {
    const sevenDaysAgo = now.getTime() - 7 * 24 * 60 * 60 * 1_000
    const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1_000
    const ninetyDaysAgo = now.getTime() - 90 * 24 * 60 * 60 * 1_000
    const oneHundredEightyDaysAgo = now.getTime() - 180 * 24 * 60 * 60 * 1_000
    let diagnosticPayloadsCleared = 0
    let processingAttemptsDeleted = 0
    for (const [id, attempt] of this.processingAttempts) {
      const finishedAt = attempt.finishedAt?.getTime()
      if (!finishedAt) continue
      if (finishedAt < sevenDaysAgo && attempt.executionMetadata !== null) {
        attempt.executionMetadata = null
        diagnosticPayloadsCleared += 1
      }
      if (
        (attempt.status === "succeeded" && finishedAt < thirtyDaysAgo) ||
        (attempt.status === "failed" && finishedAt < ninetyDaysAgo)
      ) {
        this.processingAttempts.delete(id)
        processingAttemptsDeleted += 1
      }
    }

    let entryEvaluationsDeleted = 0
    const byEntry = Map.groupBy(this.entryEvaluations.values(), (evaluation) => evaluation.entryId)
    for (const evaluations of byEntry.values()) {
      evaluations.sort((left, right) => right.processedAt.getTime() - left.processedAt.getTime())
      for (const evaluation of evaluations.slice(10)) {
        if (
          evaluation.processedAt.getTime() < oneHundredEightyDaysAgo &&
          this.entryCurrentEvaluations.get(evaluation.entryId) !== evaluation.id
        ) {
          this.entryEvaluations.delete(evaluation.id)
          entryEvaluationsDeleted += 1
        }
      }
    }

    let feedFetchAttemptsDeleted = 0
    for (const [id, attempt] of this.feedFetchAttempts) {
      if (attempt.finishedAt.getTime() < thirtyDaysAgo) {
        this.feedFetchAttempts.delete(id)
        feedFetchAttemptsDeleted += 1
      }
    }

    const syncActionsDeleted = await this.cleanupSyncActions(now)

    let processingJobsDeleted = 0
    for (const [id, job] of this.processingJobs) {
      if (
        (job.status === "failed" || job.status === "succeeded" || job.status === "superseded") &&
        job.finishedAt &&
        job.finishedAt.getTime() < oneHundredEightyDaysAgo
      ) {
        this.processingJobs.delete(id)
        processingJobsDeleted += 1
        for (const [attemptId, attempt] of this.processingAttempts) {
          if (attempt.jobId === id) {
            this.processingAttempts.delete(attemptId)
            processingAttemptsDeleted += 1
          }
        }
      }
    }

    return {
      diagnosticPayloadsCleared,
      entryEvaluationsDeleted,
      feedFetchAttemptsDeleted,
      processingAttemptsDeleted,
      processingJobsDeleted,
      syncActionsDeleted,
    }
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
    const flipped: Array<{ entryId: string; feedId: string }> = []
    for (const entryId of new Set(entryIds)) {
      const entry = await this.getEntry(userId, entryId)
      if (!entry) continue
      const key = readKey(userId, entryId)
      if (this.reads.has(key) === read) continue
      if (read) this.reads.add(key)
      else this.reads.delete(key)
      flipped.push({ entryId, feedId: entry.feedId })
    }
    this.recordSyncActions(timelineReadFlipped(userId, read, flipped))
  }

  async markAllAsRead(userId: string, filter: MarkAllReadFilter): Promise<Record<string, number>> {
    const subscriptions = (await this.listSubscriptions(userId, filter.view)).filter(
      (subscription) =>
        (filter.feedId === undefined || subscription.feedId === filter.feedId) &&
        (filter.feedIdList === undefined || filter.feedIdList.includes(subscription.feedId)),
    )
    const marked: Record<string, number> = {}
    const flipped: Array<{ entryId: string; feedId: string }> = []

    for (const subscription of subscriptions) {
      let count = 0
      for (const entry of this.entries.values()) {
        const key = readKey(userId, entry.id)
        if (entry.feedId !== subscription.feedId || this.reads.has(key)) continue
        this.reads.add(key)
        flipped.push({ entryId: entry.id, feedId: entry.feedId })
        count += 1
      }
      marked[subscription.feedId] = count
    }

    this.recordSyncActions(timelineReadFlipped(userId, true, flipped))
    return marked
  }

  async isEntryCollected(userId: string, entryId: string): Promise<boolean> {
    return this.collections.has(collectionKey(userId, entryId))
  }

  async setEntryCollected(userId: string, entryId: string, collected: boolean): Promise<void> {
    const entry = await this.getEntry(userId, entryId)
    if (!entry) return
    const key = collectionKey(userId, entryId)
    if (collected) {
      // Starring again keeps the original star time, as the PostgreSQL store does.
      if (this.collections.has(key)) return
      const createdAt = new Date()
      this.collections.set(key, createdAt)
      const view = this.subscriptions.get(subscriptionKey(userId, entry.feedId))?.view ?? 0
      this.recordSyncActions([
        collectionInserted(userId, { entryId, feedId: entry.feedId, view, createdAt }),
      ])
    } else if (this.collections.delete(key)) {
      this.recordSyncActions([collectionDeleted(userId, entryId)])
    }
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

  async listFeedFetchAttempts(feedId: string, limit: number): Promise<FeedFetchAttemptRecord[]> {
    return [...this.feedFetchAttempts.values()]
      .filter((attempt) => attempt.feedId === feedId)
      .sort((left, right) => right.finishedAt.getTime() - left.finishedAt.getTime())
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map((attempt) => structuredClone(attempt))
  }

  async checkHealth(): Promise<void> {}

  async getOperationalStats(now: Date): Promise<OperationalStats> {
    const subscribedFeedIds = new Set(this.subscriptions.values().map((item) => item.feedId))
    const subscribedFeeds = [...subscribedFeedIds]
      .map((feedId) => this.feeds.get(feedId))
      .filter((feed): feed is FeedRecord => feed !== undefined)
    const processingJobs: OperationalStats["processingJobs"] = {
      failed: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      superseded: 0,
    }
    for (const job of this.processingJobs.values()) processingJobs[job.status] += 1
    return {
      feedAcquisitionFailures: subscribedFeeds.filter((feed) => feed.consecutiveFailures > 0)
        .length,
      feedsDue: subscribedFeeds.filter((feed) => feed.nextFetchAt <= now).length,
      processingJobs,
      subscribedFeeds: subscribedFeeds.length,
    }
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
    const updatedAt = new Date()
    this.settings.set(`${userId}:${tab}`, { payload: structuredClone(payload), updatedAt })
    this.recordSyncActions([settingsUpdated(userId, tab, payload, updatedAt)])
  }

  async getUnreadSnapshot(userId: string, view?: number): Promise<UnreadSnapshot> {
    return {
      counts: await this.getUnreadCounts(userId, view),
      lastSyncId: await this.getSyncState(userId),
    }
  }

  async getSyncState(userId: string): Promise<number> {
    let lastSyncId = this.syncFloors.get(userId) ?? 0
    for (const action of this.syncLog) {
      if (action.userId === userId) lastSyncId = Math.max(lastSyncId, action.id)
    }
    return lastSyncId
  }

  async listSyncActions(userId: string, afterId: number, limit: number): Promise<SyncDelta> {
    const lastSyncId = await this.getSyncState(userId)
    // A cursor below the floor missed deleted rows; one above everything logged comes from
    // another database (a restored or rebuilt instance). Both need a fresh snapshot.
    if (afterId < (this.syncFloors.get(userId) ?? 0) || afterId > lastSyncId) {
      return { actions: [], lastSyncId, hasMore: false, reset: true }
    }
    const pending = this.syncLog.filter((action) => action.userId === userId && action.id > afterId)
    const actions = pending.slice(0, limit).map((action) => structuredClone(action))
    const hasMore = pending.length > actions.length
    return {
      actions,
      lastSyncId: hasMore ? actions.at(-1)!.id : lastSyncId,
      hasMore,
      reset: false,
    }
  }
}
