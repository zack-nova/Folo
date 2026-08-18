import type {
  ActionRulesRecord,
  AIProviderConfigRecord,
  DataStore,
  EnqueueProcessingJobResult,
  EntryEvaluationRecord,
  EntryListFilter,
  EntryRecord,
  EntrySummaryRecord,
  EntryTranslationRecord,
  FeedRecord,
  ListPatch,
  ListRecord,
  ListSubscriptionRecord,
  MarkAllReadFilter,
  ProcessingAttemptRecord,
  ProcessingJobRecord,
  ProcessingProfileSnapshotRecord,
  ProcessingTaxonomySnapshotRecord,
  ReadabilityRecord,
  SettingsRecord,
  SettingsTab,
  SubscriptionPatch,
  SubscriptionRecord,
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

  async getOwnerUserId(): Promise<string | null> {
    return this.ownerUserId
  }

  async claimOwner(userId: string): Promise<string> {
    this.ownerUserId ??= userId
    return this.ownerUserId
  }

  async saveFeed(feed: FeedRecord, entries: EntryRecord[]): Promise<void> {
    this.feeds.set(feed.id, structuredClone(feed))
    for (const entry of entries) {
      const existing = this.entries.get(entry.id)
      const saved = structuredClone(entry)
      if (existing) {
        saved.insertedAt = existing.insertedAt
        if (entry.publishedAt.getTime() === entry.insertedAt.getTime()) {
          saved.publishedAt = existing.publishedAt
        }
      }
      this.entries.set(entry.id, saved)
    }
  }

  async createSubscription(subscription: SubscriptionRecord): Promise<void> {
    this.subscriptions.set(
      subscriptionKey(subscription.userId, subscription.feedId),
      structuredClone(subscription),
    )
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
    return structuredClone(updated)
  }

  async deleteSubscriptions(userId: string, feedIds: string[]): Promise<void> {
    for (const feedId of new Set(feedIds)) {
      this.subscriptions.delete(subscriptionKey(userId, feedId))
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
  }

  async updateList(userId: string, listId: string, patch: ListPatch): Promise<ListRecord | null> {
    const current = await this.getList(userId, listId)
    if (!current) return null
    const updated = { ...current, ...structuredClone(patch), updatedAt: new Date() }
    this.lists.set(listId, updated)
    if (patch.view !== undefined) {
      await this.updateListSubscription(userId, listId, { view: patch.view })
    }
    return structuredClone(updated)
  }

  async deleteList(userId: string, listId: string): Promise<void> {
    const list = await this.getList(userId, listId)
    if (!list) return
    this.lists.delete(listId)
    for (const [key, subscription] of this.listSubscriptionRecords) {
      if (subscription.listId === listId) this.listSubscriptionRecords.delete(key)
    }
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
    return structuredClone(updated)
  }

  async deleteListSubscription(userId: string, listId: string): Promise<void> {
    this.listSubscriptionRecords.delete(listSubscriptionKey(userId, listId))
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
    limit,
  }: EntryListFilter): Promise<
    Array<{
      entry: EntryRecord
      subscription: SubscriptionRecord
      read: boolean
      collectionCreatedAt: Date | null
    }>
  > {
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
        (entry) =>
          publishedAfter === undefined || entry.publishedAt.getTime() > publishedAfter.getTime(),
      )
      .filter(
        (entry) =>
          publishedBefore === undefined || entry.publishedAt.getTime() < publishedBefore.getTime(),
      )
      .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime())
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
  }

  async cleanupProcessingHistory(now: Date): Promise<void> {
    const sevenDaysAgo = now.getTime() - 7 * 24 * 60 * 60 * 1_000
    const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1_000
    const ninetyDaysAgo = now.getTime() - 90 * 24 * 60 * 60 * 1_000
    for (const [id, attempt] of this.processingAttempts) {
      const finishedAt = attempt.finishedAt?.getTime()
      if (!finishedAt) continue
      if (finishedAt < sevenDaysAgo) attempt.executionMetadata = null
      if (
        (attempt.status === "succeeded" && finishedAt < thirtyDaysAgo) ||
        (attempt.status === "failed" && finishedAt < ninetyDaysAgo)
      ) {
        this.processingAttempts.delete(id)
      }
    }

    const oldestHistory = now.getTime() - 180 * 24 * 60 * 60 * 1_000
    const byEntry = Map.groupBy(this.entryEvaluations.values(), (evaluation) => evaluation.entryId)
    for (const evaluations of byEntry.values()) {
      evaluations.sort((left, right) => right.processedAt.getTime() - left.processedAt.getTime())
      for (const evaluation of evaluations.slice(10)) {
        if (
          evaluation.processedAt.getTime() < oldestHistory &&
          this.entryCurrentEvaluations.get(evaluation.entryId) !== evaluation.id
        ) {
          this.entryEvaluations.delete(evaluation.id)
        }
      }
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
    for (const entryId of new Set(entryIds)) {
      const entry = await this.getEntry(userId, entryId)
      if (!entry) continue
      const key = readKey(userId, entryId)
      if (read) this.reads.add(key)
      else this.reads.delete(key)
    }
  }

  async markAllAsRead(userId: string, filter: MarkAllReadFilter): Promise<Record<string, number>> {
    const subscriptions = (await this.listSubscriptions(userId, filter.view)).filter(
      (subscription) =>
        (filter.feedId === undefined || subscription.feedId === filter.feedId) &&
        (filter.feedIdList === undefined || filter.feedIdList.includes(subscription.feedId)),
    )
    const marked: Record<string, number> = {}

    for (const subscription of subscriptions) {
      let count = 0
      for (const entry of this.entries.values()) {
        const key = readKey(userId, entry.id)
        if (entry.feedId !== subscription.feedId || this.reads.has(key)) continue
        this.reads.add(key)
        count += 1
      }
      marked[subscription.feedId] = count
    }

    return marked
  }

  async isEntryCollected(userId: string, entryId: string): Promise<boolean> {
    return this.collections.has(collectionKey(userId, entryId))
  }

  async setEntryCollected(userId: string, entryId: string, collected: boolean): Promise<void> {
    if (!(await this.getEntry(userId, entryId))) return
    const key = collectionKey(userId, entryId)
    if (collected) this.collections.set(key, new Date())
    else this.collections.delete(key)
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
    this.settings.set(`${userId}:${tab}`, {
      payload: structuredClone(payload),
      updatedAt: new Date(),
    })
  }
}
