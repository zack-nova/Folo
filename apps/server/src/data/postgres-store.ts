import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  or,
  sql,
} from "drizzle-orm"

import type { ApplicationDatabase } from "../db/database"
import {
  actionRules,
  aiProviderConfigs,
  collections,
  entries,
  entryCurrentEvaluations,
  entryEvaluations,
  entryReadability,
  entrySummaries,
  entryTranslations,
  feedFetchAttempts,
  feeds,
  instanceOwnership,
  lists,
  listSubscriptions,
  processingAttempts,
  processingJobs,
  processingProfileSnapshots,
  processingTaxonomySnapshots,
  readStates,
  settings,
  subscriptions,
  syncActions,
  syncFloors,
} from "../db/schema"
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
  SyncActionType,
  SyncDelta,
  SyncModel,
  UnreadSnapshot,
} from "./types"

type Transaction = Parameters<Parameters<ApplicationDatabase["transaction"]>[0]>[0]
type Executor = ApplicationDatabase | Transaction

/** Namespaces the per-user advisory locks that order the sync log. */
const SYNC_LOCK_CLASS = 0x5f10

/**
 * Appends change log rows as the last statement of the caller's transaction. Holding a per-user
 * lock until commit makes one user's ids commit in id order, so a client can never advance its
 * cursor past a row that is not visible yet.
 */
const appendSyncActions = async (transaction: Transaction, actions: SyncActionInput[]) => {
  if (actions.length === 0) return
  // Sorted, so concurrent writers that touch several users cannot deadlock.
  for (const userId of [...new Set(actions.map((action) => action.userId))].sort()) {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${SYNC_LOCK_CLASS}, hashtext(${userId}))`,
    )
  }
  await transaction.insert(syncActions).values(
    actions.map((action) => ({
      userId: action.userId,
      model: action.model,
      modelId: action.modelId,
      action: action.action,
      data: action.data,
    })),
  )
}

const syncState = async (executor: Executor, userId: string): Promise<number> => {
  const [[logged], [floor]] = await Promise.all([
    executor
      .select({ lastSyncId: max(syncActions.id) })
      .from(syncActions)
      .where(eq(syncActions.userId, userId)),
    executor
      .select({ floorId: syncFloors.floorId })
      .from(syncFloors)
      .where(eq(syncFloors.userId, userId)),
  ])
  return Math.max(Number(logged?.lastSyncId ?? 0), floor?.floorId ?? 0)
}

/**
 * Deletes expired log rows. Deleting anything but "new entries" hints raises the user's floor,
 * so a client whose cursor is older takes a fresh snapshot instead of missing the change.
 */
const deleteExpiredSyncActions = async (transaction: Transaction, now: Date) => {
  const hintCutoff = new Date(now.getTime() - SYNC_HINT_RETENTION_MS)
  const actionCutoff = new Date(now.getTime() - SYNC_ACTION_RETENTION_MS)
  const hints = await transaction.execute<{ count: string }>(sql`
    with deleted as (
      delete from ${syncActions}
      where ${syncActions.action} = 'N' and ${syncActions.createdAt} < ${hintCutoff}
      returning 1
    )
    select count(*) as count from deleted
  `)
  const actions = await transaction.execute<{ count: string }>(sql`
    with deleted as (
      delete from ${syncActions}
      where ${syncActions.createdAt} < ${actionCutoff}
      returning ${syncActions.userId} as user_id, ${syncActions.id} as id
    ),
    floors as (
      insert into ${syncFloors} (user_id, floor_id)
      select user_id, max(id) from deleted group by user_id
      on conflict (user_id) do update
        set floor_id = greatest(${syncFloors.floorId}, excluded.floor_id)
    )
    select count(*) as count from deleted
  `)
  return Number(hints.rows[0]?.count ?? 0) + Number(actions.rows[0]?.count ?? 0)
}

const unreadCounts = async (
  executor: Executor,
  userId: string,
  view?: number,
): Promise<Record<string, number>> => {
  const userSubscriptions = await executor
    .select({ feedId: subscriptions.feedId })
    .from(subscriptions)
    .where(
      view === undefined
        ? eq(subscriptions.userId, userId)
        : and(eq(subscriptions.userId, userId), eq(subscriptions.view, view)),
    )
  const result: Record<string, number> = Object.fromEntries(
    userSubscriptions.map((subscription) => [subscription.feedId, 0]),
  )
  if (userSubscriptions.length === 0) return result

  const rows = await executor
    .select({
      feedId: entries.feedId,
      count: sql<number>`count(${entries.id})`.mapWith(Number),
    })
    .from(entries)
    .leftJoin(readStates, and(eq(readStates.entryId, entries.id), eq(readStates.userId, userId)))
    .where(
      and(
        inArray(
          entries.feedId,
          userSubscriptions.map((subscription) => subscription.feedId),
        ),
        isNull(readStates.readAt),
      ),
    )
    .groupBy(entries.feedId)

  for (const row of rows) result[row.feedId] = row.count
  return result
}

/** Changes the read state of the user's entries and returns only the rows that really flipped. */
const flipReadStates = async (
  transaction: Transaction,
  userId: string,
  entryIds: string[],
  read: boolean,
): Promise<Array<{ entryId: string; feedId: string }>> => {
  const allowed = await transaction
    .select({ id: entries.id, feedId: entries.feedId })
    .from(entries)
    .innerJoin(
      subscriptions,
      and(eq(subscriptions.feedId, entries.feedId), eq(subscriptions.userId, userId)),
    )
    .where(inArray(entries.id, entryIds))
  if (allowed.length === 0) return []
  const feedIdByEntry = new Map(allowed.map((row) => [row.id, row.feedId]))

  const changed = read
    ? (
        await transaction
          .insert(readStates)
          .values(allowed.map((row) => ({ userId, entryId: row.id, readAt: new Date() })))
          .onConflictDoUpdate({
            target: [readStates.userId, readStates.entryId],
            set: { readAt: sql`excluded.read_at` },
          })
          // xmax is 0 for a row this statement inserted, i.e. an entry that was unread.
          .returning({ entryId: readStates.entryId, inserted: sql<boolean>`xmax = 0` })
      ).filter((row) => row.inserted)
    : await transaction
        .delete(readStates)
        .where(
          and(
            eq(readStates.userId, userId),
            inArray(
              readStates.entryId,
              allowed.map((row) => row.id),
            ),
          ),
        )
        .returning({ entryId: readStates.entryId })

  // Row order above follows whichever plan Postgres picks (an index scan returns id order), so
  // the logged entry ids keep the caller's order instead, as the memory store does.
  const position = new Map([...new Set(entryIds)].map((entryId, index) => [entryId, index]))
  return changed
    .map((row) => ({ entryId: row.entryId, feedId: feedIdByEntry.get(row.entryId)! }))
    .sort((left, right) => position.get(left.entryId)! - position.get(right.entryId)!)
}

export class PostgresDataStore implements DataStore {
  constructor(private readonly database: ApplicationDatabase) {}

  async getOwnerUserId(): Promise<string | null> {
    const [owner] = await this.database
      .select({ userId: instanceOwnership.userId })
      .from(instanceOwnership)
      .where(eq(instanceOwnership.id, "primary"))
      .limit(1)
    return owner?.userId ?? null
  }

  async claimOwner(userId: string): Promise<string> {
    await this.database
      .insert(instanceOwnership)
      .values({ createdAt: new Date(), id: "primary", userId })
      .onConflictDoNothing()
    const ownerUserId = await this.getOwnerUserId()
    if (!ownerUserId) throw new Error("The instance owner could not be established")
    return ownerUserId
  }

  async saveFeed(
    feed: FeedRecord,
    entryRecords: EntryRecord[],
    attempt?: FeedFetchAttemptRecord,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction
        .insert(feeds)
        .values(feed)
        .onConflictDoUpdate({
          target: feeds.id,
          set: {
            url: feed.url,
            title: feed.title,
            description: feed.description,
            siteUrl: feed.siteUrl,
            image: feed.image,
            errorAt: feed.errorAt,
            errorMessage: feed.errorMessage,
            etag: feed.etag,
            lastModified: feed.lastModified,
            fetchedAt: feed.fetchedAt,
            consecutiveFailures: feed.consecutiveFailures,
            lastSuccessAt: feed.lastSuccessAt,
            nextFetchAt: feed.nextFetchAt,
          },
        })

      let inserted: Array<{ publishedAt: Date }> = []
      if (entryRecords.length > 0) {
        const saved = await transaction
          .insert(entries)
          .values(entryRecords)
          .onConflictDoUpdate({
            target: entries.id,
            set: {
              title: sql`excluded.title`,
              description: sql`excluded.description`,
              content: sql`excluded.content`,
              url: sql`excluded.url`,
              author: sql`excluded.author`,
              authorUrl: sql`excluded.author_url`,
              authorAvatar: sql`excluded.author_avatar`,
              language: sql`excluded.language`,
              categories: sql`excluded.categories`,
              attachments: sql`excluded.attachments`,
              media: sql`excluded.media`,
              extra: sql`excluded.extra`,
              publishedAt: sql`case
                when excluded.published_at = excluded.inserted_at then ${entries.publishedAt}
                else excluded.published_at
              end`,
            },
          })
          // xmax is 0 for a row this statement inserted rather than updated.
          .returning({ publishedAt: entries.publishedAt, inserted: sql<boolean>`xmax = 0` })
        inserted = saved.filter((row) => row.inserted)
      }
      if (attempt) {
        await transaction.insert(feedFetchAttempts).values(attempt)
        await transaction.execute(sql`
          delete from ${feedFetchAttempts}
          where ${feedFetchAttempts.feedId} = ${attempt.feedId}
            and ${feedFetchAttempts.id} not in (
              select ${feedFetchAttempts.id}
              from ${feedFetchAttempts}
              where ${feedFetchAttempts.feedId} = ${attempt.feedId}
              order by ${feedFetchAttempts.finishedAt} desc
              limit 500
            )
        `)
      }
      if (inserted.length === 0) return
      const [subscribers, containingLists] = await Promise.all([
        transaction
          .select({ userId: subscriptions.userId })
          .from(subscriptions)
          .where(eq(subscriptions.feedId, feed.id)),
        transaction
          .select({ id: lists.id, ownerUserId: lists.ownerUserId })
          .from(lists)
          .where(arrayContains(lists.feedIds, [feed.id])),
      ])
      await appendSyncActions(
        transaction,
        subscribers.map(({ userId }) =>
          timelineEntriesArrived(
            userId,
            feed.id,
            inserted,
            containingLists.filter((list) => list.ownerUserId === userId).map((list) => list.id),
          ),
        ),
      )
    })
  }

  async createSubscription(subscription: SubscriptionRecord): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [saved] = await transaction
        .insert(subscriptions)
        .values(subscription)
        .onConflictDoUpdate({
          target: [subscriptions.userId, subscriptions.feedId],
          set: {
            view: subscription.view,
            category: subscription.category,
            title: subscription.title,
            isPrivate: subscription.isPrivate,
            hideFromTimeline: subscription.hideFromTimeline,
          },
        })
        .returning()
      const [feed] = await transaction
        .select()
        .from(feeds)
        .where(eq(feeds.id, subscription.feedId))
        .limit(1)
      if (saved && feed) await appendSyncActions(transaction, [subscriptionInserted(saved, feed)])
    })
  }

  async updateSubscription(
    userId: string,
    feedId: string,
    patch: SubscriptionPatch,
  ): Promise<SubscriptionRecord | null> {
    return this.database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(subscriptions)
        .set(patch)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
        .returning()
      if (updated) {
        await appendSyncActions(transaction, [subscriptionUpdated(userId, feedId, patch)])
      }
      return updated ?? null
    })
  }

  async deleteSubscriptions(userId: string, feedIds: string[]): Promise<void> {
    if (feedIds.length === 0) return
    await this.database.transaction(async (transaction) => {
      const deleted = await transaction
        .delete(subscriptions)
        .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.feedId, feedIds)))
        .returning({ feedId: subscriptions.feedId })
      await appendSyncActions(
        transaction,
        deleted.map(({ feedId }) => subscriptionDeleted(userId, feedId)),
      )
    })
  }

  async getSubscription(userId: string, feedId: string): Promise<SubscriptionRecord | null> {
    const [subscription] = await this.database
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
      .limit(1)
    return subscription ?? null
  }

  async listSubscriptions(userId: string, view?: number): Promise<SubscriptionRecord[]> {
    return this.database
      .select()
      .from(subscriptions)
      .where(
        view === undefined
          ? eq(subscriptions.userId, userId)
          : and(eq(subscriptions.userId, userId), eq(subscriptions.view, view)),
      )
  }

  async createList(list: ListRecord, subscription: ListSubscriptionRecord): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(lists).values(list)
      await transaction.insert(listSubscriptions).values(subscription)
      await appendSyncActions(transaction, [listSubscriptionInserted(subscription, list)])
    })
  }

  async updateList(userId: string, listId: string, patch: ListPatch): Promise<ListRecord | null> {
    const updatedAt = new Date()
    return this.database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(lists)
        .set({ ...patch, updatedAt })
        .where(and(eq(lists.id, listId), eq(lists.ownerUserId, userId)))
        .returning()
      if (!updated) return null
      const actions = [listUpdated(userId, listId, patch)]
      if (patch.view !== undefined) {
        const changed = await transaction
          .update(listSubscriptions)
          .set({ view: patch.view })
          .where(and(eq(listSubscriptions.userId, userId), eq(listSubscriptions.listId, listId)))
          .returning({ listId: listSubscriptions.listId })
        if (changed.length > 0) {
          actions.push(listSubscriptionUpdated(userId, listId, { view: patch.view }))
        }
      }
      await appendSyncActions(transaction, actions)
      return updated
    })
  }

  async deleteList(userId: string, listId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const subscribers = await transaction
        .select({ userId: listSubscriptions.userId })
        .from(listSubscriptions)
        .where(eq(listSubscriptions.listId, listId))
      const deleted = await transaction
        .delete(lists)
        .where(and(eq(lists.id, listId), eq(lists.ownerUserId, userId)))
        .returning({ id: lists.id })
      if (deleted.length === 0) return
      // Clients drop their subscription to the list along with it.
      const userIds = new Set([userId, ...subscribers.map((subscriber) => subscriber.userId)])
      await appendSyncActions(
        transaction,
        [...userIds].map((id) => listDeleted(id, listId)),
      )
    })
  }

  async getList(userId: string, listId: string): Promise<ListRecord | null> {
    const [list] = await this.database
      .select()
      .from(lists)
      .where(and(eq(lists.id, listId), eq(lists.ownerUserId, userId)))
      .limit(1)
    return list ?? null
  }

  async listLists(userId: string): Promise<ListRecord[]> {
    return this.database.select().from(lists).where(eq(lists.ownerUserId, userId))
  }

  async setListFeeds(
    userId: string,
    listId: string,
    feedIds: string[],
  ): Promise<ListRecord | null> {
    return this.database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(lists)
        .set({ feedIds: [...new Set(feedIds)], updatedAt: new Date() })
        .where(and(eq(lists.id, listId), eq(lists.ownerUserId, userId)))
        .returning()
      if (updated) {
        await appendSyncActions(transaction, [
          listUpdated(userId, listId, { feedIds: updated.feedIds }),
        ])
      }
      return updated ?? null
    })
  }

  async listListSubscriptions(userId: string, view?: number): Promise<ListSubscriptionRecord[]> {
    return this.database
      .select()
      .from(listSubscriptions)
      .where(
        view === undefined
          ? eq(listSubscriptions.userId, userId)
          : and(eq(listSubscriptions.userId, userId), eq(listSubscriptions.view, view)),
      )
  }

  async updateListSubscription(
    userId: string,
    listId: string,
    patch: SubscriptionPatch,
  ): Promise<ListSubscriptionRecord | null> {
    return this.database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(listSubscriptions)
        .set(patch)
        .where(and(eq(listSubscriptions.userId, userId), eq(listSubscriptions.listId, listId)))
        .returning()
      if (updated) {
        await appendSyncActions(transaction, [listSubscriptionUpdated(userId, listId, patch)])
      }
      return updated ?? null
    })
  }

  async deleteListSubscription(userId: string, listId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const deleted = await transaction
        .delete(listSubscriptions)
        .where(and(eq(listSubscriptions.userId, userId), eq(listSubscriptions.listId, listId)))
        .returning({ listId: listSubscriptions.listId })
      if (deleted.length > 0) {
        await appendSyncActions(transaction, [listSubscriptionDeleted(userId, listId)])
      }
    })
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
    if (feedIdList?.length === 0) return []

    const conditions = [eq(subscriptions.userId, userId)]
    if (view !== undefined) conditions.push(eq(subscriptions.view, view))
    if (feedId !== undefined) conditions.push(eq(subscriptions.feedId, feedId))
    if (feedIdList !== undefined && feedIdList.length > 0) {
      conditions.push(inArray(subscriptions.feedId, feedIdList))
    }
    if (read === true) conditions.push(isNotNull(readStates.readAt))
    if (read === false) conditions.push(isNull(readStates.readAt))
    if (isCollection === true) conditions.push(isNotNull(collections.createdAt))
    const orderColumn = isCollection === true ? collections.createdAt : entries.publishedAt
    if (publishedAfter !== undefined) conditions.push(gt(orderColumn, publishedAfter))
    if (publishedBefore !== undefined) conditions.push(lt(orderColumn, publishedBefore))

    const rows = await this.database
      .select({
        entry: entries,
        subscription: subscriptions,
        readAt: readStates.readAt,
        collectionCreatedAt: collections.createdAt,
      })
      .from(entries)
      .innerJoin(subscriptions, eq(subscriptions.feedId, entries.feedId))
      .leftJoin(readStates, and(eq(readStates.entryId, entries.id), eq(readStates.userId, userId)))
      .leftJoin(
        collections,
        and(eq(collections.entryId, entries.id), eq(collections.userId, userId)),
      )
      .where(and(...conditions))
      .orderBy(sortOrder === "asc" ? asc(orderColumn) : desc(orderColumn))
      .limit(limit)

    return rows.map((row) => ({
      entry: row.entry,
      subscription: row.subscription,
      read: row.readAt !== null,
      collectionCreatedAt: row.collectionCreatedAt,
    }))
  }

  async getFeed(id: string): Promise<FeedRecord | null> {
    const [feed] = await this.database.select().from(feeds).where(eq(feeds.id, id)).limit(1)
    return feed ?? null
  }

  async getFeedByUrl(url: string): Promise<FeedRecord | null> {
    const [feed] = await this.database.select().from(feeds).where(eq(feeds.url, url)).limit(1)
    return feed ?? null
  }

  async getEntry(userId: string, id: string): Promise<EntryRecord | null> {
    const [row] = await this.database
      .select({ entry: entries })
      .from(entries)
      .innerJoin(
        subscriptions,
        and(eq(subscriptions.feedId, entries.feedId), eq(subscriptions.userId, userId)),
      )
      .where(eq(entries.id, id))
      .limit(1)
    return row?.entry ?? null
  }

  async getReadability(userId: string, entryId: string): Promise<ReadabilityRecord | null> {
    const [record] = await this.database
      .select({ readability: entryReadability })
      .from(entryReadability)
      .innerJoin(entries, eq(entries.id, entryReadability.entryId))
      .innerJoin(
        subscriptions,
        and(eq(subscriptions.feedId, entries.feedId), eq(subscriptions.userId, userId)),
      )
      .where(eq(entryReadability.entryId, entryId))
      .limit(1)
    return record?.readability ?? null
  }

  async setReadability(userId: string, entryId: string, content: string): Promise<void> {
    if (!(await this.getEntry(userId, entryId))) return
    const updatedAt = new Date()
    await this.database
      .insert(entryReadability)
      .values({ content, entryId, updatedAt })
      .onConflictDoUpdate({
        target: entryReadability.entryId,
        set: { content, updatedAt },
      })
  }

  async getAIProviderConfig(userId: string): Promise<AIProviderConfigRecord | null> {
    const [config] = await this.database
      .select()
      .from(aiProviderConfigs)
      .where(eq(aiProviderConfigs.userId, userId))
      .limit(1)
    return (config as AIProviderConfigRecord | undefined) ?? null
  }

  async setAIProviderConfig(config: AIProviderConfigRecord): Promise<void> {
    await this.database
      .insert(aiProviderConfigs)
      .values(config)
      .onConflictDoUpdate({
        target: aiProviderConfigs.userId,
        set: {
          baseUrl: config.baseUrl,
          encryptedApiKey: config.encryptedApiKey,
          keyHint: config.keyHint,
          model: config.model,
          type: config.type,
          updatedAt: config.updatedAt,
        },
      })
  }

  async deleteAIProviderConfig(userId: string): Promise<void> {
    await this.database.delete(aiProviderConfigs).where(eq(aiProviderConfigs.userId, userId))
  }

  async createProcessingProfileSnapshot(
    snapshot: ProcessingProfileSnapshotRecord,
  ): Promise<ProcessingProfileSnapshotRecord> {
    await this.database.insert(processingProfileSnapshots).values(snapshot)
    return snapshot
  }

  async listProcessingProfileSnapshots(userId: string): Promise<ProcessingProfileSnapshotRecord[]> {
    return this.database
      .select()
      .from(processingProfileSnapshots)
      .where(eq(processingProfileSnapshots.userId, userId))
      .orderBy(desc(processingProfileSnapshots.createdAt), desc(processingProfileSnapshots.version))
  }

  async getProcessingProfileSnapshot(
    userId: string,
    snapshotId: string,
  ): Promise<ProcessingProfileSnapshotRecord | null> {
    const [snapshot] = await this.database
      .select()
      .from(processingProfileSnapshots)
      .where(
        and(
          eq(processingProfileSnapshots.userId, userId),
          eq(processingProfileSnapshots.id, snapshotId),
        ),
      )
      .limit(1)
    return snapshot ?? null
  }

  async createProcessingTaxonomySnapshot(
    snapshot: ProcessingTaxonomySnapshotRecord,
  ): Promise<ProcessingTaxonomySnapshotRecord> {
    await this.database.insert(processingTaxonomySnapshots).values(snapshot)
    return snapshot
  }

  async listProcessingTaxonomySnapshots(
    userId: string,
  ): Promise<ProcessingTaxonomySnapshotRecord[]> {
    return this.database
      .select()
      .from(processingTaxonomySnapshots)
      .where(eq(processingTaxonomySnapshots.userId, userId))
      .orderBy(
        desc(processingTaxonomySnapshots.createdAt),
        desc(processingTaxonomySnapshots.version),
      )
  }

  async getProcessingTaxonomySnapshot(
    userId: string,
    snapshotId: string,
  ): Promise<ProcessingTaxonomySnapshotRecord | null> {
    const [snapshot] = await this.database
      .select()
      .from(processingTaxonomySnapshots)
      .where(
        and(
          eq(processingTaxonomySnapshots.userId, userId),
          eq(processingTaxonomySnapshots.id, snapshotId),
        ),
      )
      .limit(1)
    return snapshot ?? null
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

    try {
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${job.userId}:${job.entryId}:${job.purpose}`}))`,
        )
        const [active] = await transaction
          .select()
          .from(processingJobs)
          .where(
            and(
              eq(processingJobs.idempotencyKey, job.idempotencyKey),
              inArray(processingJobs.status, ["queued", "running"]),
            ),
          )
          .limit(1)
        if (active) {
          if (active.status === "queued" && job.priority > active.priority) {
            const [reprioritized] = await transaction
              .update(processingJobs)
              .set({ priority: job.priority })
              .where(and(eq(processingJobs.id, active.id), eq(processingJobs.status, "queued")))
              .returning()
            return {
              job: (reprioritized ?? active) as ProcessingJobRecord,
              outcome: "reused" as const,
            }
          }
          return { job: active as ProcessingJobRecord, outcome: "reused" as const }
        }
        const superseded = await transaction
          .update(processingJobs)
          .set({ finishedAt: new Date(), status: "superseded", supersededByJobId: job.id })
          .where(
            and(
              eq(processingJobs.userId, job.userId),
              eq(processingJobs.entryId, job.entryId),
              eq(processingJobs.purpose, job.purpose),
              eq(processingJobs.status, "queued"),
            ),
          )
          .returning({ id: processingJobs.id })
        await transaction.insert(processingJobs).values(job)
        return { job, outcome: "created" as const, supersededCount: superseded.length }
      })
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "23505")) throw error
      const [active] = await this.database
        .select()
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.idempotencyKey, job.idempotencyKey),
            inArray(processingJobs.status, ["queued", "running"]),
          ),
        )
        .limit(1)
      if (!active) throw error
      if (active.status === "queued" && job.priority > active.priority) {
        const [reprioritized] = await this.database
          .update(processingJobs)
          .set({ priority: job.priority })
          .where(and(eq(processingJobs.id, active.id), eq(processingJobs.status, "queued")))
          .returning()
        return {
          job: (reprioritized ?? active) as ProcessingJobRecord,
          outcome: "reused",
        }
      }
      return { job: active as ProcessingJobRecord, outcome: "reused" }
    }
  }

  async claimNextProcessingJob(now: Date): Promise<ProcessingJobRecord | null> {
    return this.database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select()
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.status, "queued"),
            or(isNull(processingJobs.nextRetryAt), lte(processingJobs.nextRetryAt, now)),
            sql`not exists (
              select 1 from ${processingJobs} running
              where running.entry_id = ${processingJobs.entryId}
                and running.purpose = ${processingJobs.purpose}
                and running.status = 'running'
            )`,
          ),
        )
        .orderBy(desc(processingJobs.priority), asc(processingJobs.queuedAt))
        .limit(1)
        .for("update", { skipLocked: true })
      if (!candidate) return null
      const [claimed] = await transaction
        .update(processingJobs)
        .set({
          attemptCount: candidate.attemptCount + 1,
          startedAt: now,
          status: "running",
        })
        .where(and(eq(processingJobs.id, candidate.id), eq(processingJobs.status, "queued")))
        .returning()
      return (claimed as ProcessingJobRecord | undefined) ?? null
    })
  }

  async getProcessingJob(userId: string, jobId: string): Promise<ProcessingJobRecord | null> {
    const [job] = await this.database
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.userId, userId), eq(processingJobs.id, jobId)))
      .limit(1)
    return (job as ProcessingJobRecord | undefined) ?? null
  }

  async listFailedProcessingJobs(userId: string, limit: number): Promise<ProcessingJobRecord[]> {
    return (await this.database
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.userId, userId), eq(processingJobs.status, "failed")))
      .orderBy(desc(processingJobs.finishedAt))
      .limit(Math.min(Math.max(limit, 1), 100))) as ProcessingJobRecord[]
  }

  async listProcessingAttempts(userId: string, jobId: string): Promise<ProcessingAttemptRecord[]> {
    const job = await this.getProcessingJob(userId, jobId)
    if (!job) return []
    return (await this.database
      .select()
      .from(processingAttempts)
      .where(eq(processingAttempts.jobId, jobId))
      .orderBy(asc(processingAttempts.attemptNumber))) as ProcessingAttemptRecord[]
  }

  async getEntryProcessingJobs(userId: string, entryId: string): Promise<ProcessingJobRecord[]> {
    return (await this.database
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.userId, userId), eq(processingJobs.entryId, entryId)))
      .orderBy(
        sql`case when ${processingJobs.status} in ('queued', 'running') then 1 else 0 end desc`,
        desc(processingJobs.queuedAt),
      )) as ProcessingJobRecord[]
  }

  async getEntryProjections(
    userId: string,
    entryIds: string[],
  ): Promise<Record<string, EntryProjectionRecord>> {
    const uniqueIds = [...new Set(entryIds)]
    const result = Object.fromEntries(
      uniqueIds.map((entryId) => [entryId, { evaluation: null, processingJob: null }]),
    ) as Record<string, EntryProjectionRecord>
    if (uniqueIds.length === 0) return result

    const evaluationRows = await this.database
      .select({ entryId: entries.id, evaluation: entryEvaluations })
      .from(entries)
      .innerJoin(
        subscriptions,
        and(eq(subscriptions.feedId, entries.feedId), eq(subscriptions.userId, userId)),
      )
      .innerJoin(entryCurrentEvaluations, eq(entryCurrentEvaluations.entryId, entries.id))
      .innerJoin(entryEvaluations, eq(entryEvaluations.id, entryCurrentEvaluations.evaluationId))
      .where(inArray(entries.id, uniqueIds))
    for (const row of evaluationRows) {
      result[row.entryId]!.evaluation = row.evaluation as EntryEvaluationRecord
    }

    const jobRows = await this.database
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.userId, userId), inArray(processingJobs.entryId, uniqueIds)))
      .orderBy(
        sql`case when ${processingJobs.status} in ('queued', 'running') then 1 else 0 end desc`,
        desc(processingJobs.queuedAt),
      )
    for (const job of jobRows) {
      const projection = result[job.entryId]
      if (projection && !projection.processingJob) {
        projection.processingJob = job as ProcessingJobRecord
      }
    }
    return result
  }

  async completeProcessingJob(input: {
    attempt: ProcessingAttemptRecord
    evaluation: EntryEvaluationRecord
    jobId: string
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [completedJob] = await transaction
        .update(processingJobs)
        .set({
          finishedAt: input.attempt.finishedAt ?? new Date(),
          lastErrorCode: null,
          lastErrorSummary: null,
          nextRetryAt: null,
          status: "succeeded",
        })
        .where(and(eq(processingJobs.id, input.jobId), eq(processingJobs.status, "running")))
        .returning({ id: processingJobs.id })
      if (!completedJob) return
      await transaction.insert(entryEvaluations).values(input.evaluation)
      await transaction
        .insert(entryCurrentEvaluations)
        .values({
          entryId: input.evaluation.entryId,
          evaluationId: input.evaluation.id,
          selectedAt: input.evaluation.processedAt,
          selectionReason: "processing_succeeded",
        })
        .onConflictDoUpdate({
          target: entryCurrentEvaluations.entryId,
          set: {
            evaluationId: input.evaluation.id,
            selectedAt: input.evaluation.processedAt,
            selectionReason: "processing_succeeded",
          },
        })
      await transaction.insert(processingAttempts).values(input.attempt)
    })
  }

  async failProcessingJob(input: {
    attempt: ProcessingAttemptRecord
    errorCode: string
    errorSummary: string
    jobId: string
    nextRetryAt: Date | null
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(processingAttempts).values(input.attempt)
      await transaction
        .update(processingJobs)
        .set({
          finishedAt: input.nextRetryAt ? null : (input.attempt.finishedAt ?? new Date()),
          lastErrorCode: input.errorCode,
          lastErrorSummary: input.errorSummary,
          nextRetryAt: input.nextRetryAt,
          status: input.nextRetryAt ? "queued" : "failed",
        })
        .where(and(eq(processingJobs.id, input.jobId), eq(processingJobs.status, "running")))
    })
  }

  async retryProcessingJob(userId: string, jobId: string): Promise<ProcessingJobRecord | null> {
    const [job] = await this.database
      .update(processingJobs)
      .set({
        finishedAt: null,
        lastErrorCode: null,
        lastErrorSummary: null,
        nextRetryAt: null,
        status: "queued",
      })
      .where(
        and(
          eq(processingJobs.userId, userId),
          eq(processingJobs.id, jobId),
          eq(processingJobs.status, "failed"),
        ),
      )
      .returning()
    return (job as ProcessingJobRecord | undefined) ?? null
  }

  async getCurrentEntryEvaluation(
    userId: string,
    entryId: string,
  ): Promise<EntryEvaluationRecord | null> {
    const [row] = await this.database
      .select({ evaluation: entryEvaluations })
      .from(entryCurrentEvaluations)
      .innerJoin(entryEvaluations, eq(entryEvaluations.id, entryCurrentEvaluations.evaluationId))
      .innerJoin(entries, eq(entries.id, entryCurrentEvaluations.entryId))
      .innerJoin(
        subscriptions,
        and(eq(subscriptions.feedId, entries.feedId), eq(subscriptions.userId, userId)),
      )
      .where(eq(entryCurrentEvaluations.entryId, entryId))
      .limit(1)
    return (row?.evaluation as EntryEvaluationRecord | undefined) ?? null
  }

  async listEntryEvaluations(userId: string, entryId: string): Promise<EntryEvaluationRecord[]> {
    const allowedEntry = await this.getEntry(userId, entryId)
    if (!allowedEntry) return []
    return (await this.database
      .select()
      .from(entryEvaluations)
      .where(eq(entryEvaluations.entryId, entryId))
      .orderBy(desc(entryEvaluations.processedAt))) as EntryEvaluationRecord[]
  }

  async selectEntryEvaluation(
    userId: string,
    entryId: string,
    evaluationId: string,
    reason: string,
  ): Promise<EntryEvaluationRecord | null> {
    if (!(await this.getEntry(userId, entryId))) return null
    const [evaluation] = await this.database
      .select()
      .from(entryEvaluations)
      .where(and(eq(entryEvaluations.entryId, entryId), eq(entryEvaluations.id, evaluationId)))
      .limit(1)
    if (!evaluation) return null
    await this.database
      .insert(entryCurrentEvaluations)
      .values({ entryId, evaluationId, selectedAt: new Date(), selectionReason: reason })
      .onConflictDoUpdate({
        target: entryCurrentEvaluations.entryId,
        set: { evaluationId, selectedAt: new Date(), selectionReason: reason },
      })
    return evaluation as EntryEvaluationRecord
  }

  async getEntrySummary(
    userId: string,
    entryId: string,
    language: string,
    target: EntrySummaryRecord["target"],
  ): Promise<EntrySummaryRecord | null> {
    if (!(await this.getEntry(userId, entryId))) return null
    const [summary] = await this.database
      .select()
      .from(entrySummaries)
      .where(
        and(
          eq(entrySummaries.entryId, entryId),
          eq(entrySummaries.language, language),
          eq(entrySummaries.target, target),
        ),
      )
      .limit(1)
    return (summary as EntrySummaryRecord | undefined) ?? null
  }

  async setEntrySummary(userId: string, summary: EntrySummaryRecord): Promise<void> {
    if (!(await this.getEntry(userId, summary.entryId))) return
    await this.database
      .insert(entrySummaries)
      .values(summary)
      .onConflictDoUpdate({
        target: [entrySummaries.entryId, entrySummaries.language, entrySummaries.target],
        set: { createdAt: summary.createdAt, model: summary.model, summary: summary.summary },
      })
  }

  async getEntryTranslation(
    userId: string,
    entryId: string,
    language: string,
  ): Promise<EntryTranslationRecord | null> {
    if (!(await this.getEntry(userId, entryId))) return null
    const [translation] = await this.database
      .select()
      .from(entryTranslations)
      .where(and(eq(entryTranslations.entryId, entryId), eq(entryTranslations.language, language)))
      .limit(1)
    return (translation as EntryTranslationRecord | undefined) ?? null
  }

  async setEntryTranslation(userId: string, translation: EntryTranslationRecord): Promise<void> {
    if (!(await this.getEntry(userId, translation.entryId))) return
    await this.database
      .insert(entryTranslations)
      .values(translation)
      .onConflictDoUpdate({
        target: [entryTranslations.entryId, entryTranslations.language],
        set: {
          content: translation.content,
          createdAt: translation.createdAt,
          description: translation.description,
          model: translation.model,
          readabilityContent: translation.readabilityContent,
          title: translation.title,
        },
      })
  }

  async getActionRules(userId: string): Promise<ActionRulesRecord | null> {
    const [record] = await this.database
      .select()
      .from(actionRules)
      .where(eq(actionRules.userId, userId))
      .limit(1)
    return record ?? null
  }

  async setActionRulesIfUnchanged(
    userId: string,
    rules: Array<Record<string, unknown>>,
    expectedUpdatedAt: Date | null,
  ): Promise<boolean> {
    const now = new Date()
    return this.database.transaction(async (transaction) => {
      const written = expectedUpdatedAt
        ? await transaction
            .update(actionRules)
            .set({ rules, updatedAt: now })
            .where(
              and(eq(actionRules.userId, userId), eq(actionRules.updatedAt, expectedUpdatedAt)),
            )
            .returning({ userId: actionRules.userId })
        : await transaction
            .insert(actionRules)
            .values({ createdAt: now, rules, updatedAt: now, userId })
            .onConflictDoNothing({ target: actionRules.userId })
            .returning({ userId: actionRules.userId })
      if (written.length === 0) return false
      await appendSyncActions(transaction, [actionRulesUpdated(userId, rules)])
      return true
    })
  }

  async setActionRules(userId: string, rules: Array<Record<string, unknown>>): Promise<void> {
    const now = new Date()
    await this.database.transaction(async (transaction) => {
      await transaction
        .insert(actionRules)
        .values({ createdAt: now, rules, updatedAt: now, userId })
        .onConflictDoUpdate({
          target: actionRules.userId,
          set: { rules, updatedAt: now },
        })
      await appendSyncActions(transaction, [actionRulesUpdated(userId, rules)])
    })
  }

  async cleanupProcessingHistory(now: Date): Promise<MaintenanceCleanupReport> {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000)
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000)
    const oneHundredEightyDaysAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1_000)
    return this.database.transaction(async (transaction) => {
      const diagnosticPayloadsCleared = await transaction
        .update(processingAttempts)
        .set({ executionMetadata: null })
        .where(
          and(
            lt(processingAttempts.finishedAt, sevenDaysAgo),
            isNotNull(processingAttempts.executionMetadata),
          ),
        )
        .returning({ id: processingAttempts.id })
      const deletedAttempts = await transaction
        .delete(processingAttempts)
        .where(
          or(
            and(
              eq(processingAttempts.status, "succeeded"),
              lt(processingAttempts.finishedAt, thirtyDaysAgo),
            ),
            and(
              eq(processingAttempts.status, "failed"),
              lt(processingAttempts.finishedAt, ninetyDaysAgo),
            ),
          ),
        )
        .returning({ id: processingAttempts.id })
      const deletedEvaluations = await transaction.execute<{ id: string }>(sql`
        delete from ${entryEvaluations} evaluation
        using (
          select id, row_number() over (
            partition by entry_id order by processed_at desc
          ) as history_rank
          from ${entryEvaluations}
        ) ranked
        where evaluation.id = ranked.id
          and ranked.history_rank > 10
          and evaluation.processed_at < ${oneHundredEightyDaysAgo}
          and not exists (
            select 1 from ${entryCurrentEvaluations} current_evaluation
            where current_evaluation.evaluation_id = evaluation.id
          )
        returning evaluation.id
      `)
      const deletedFeedAttempts = await transaction
        .delete(feedFetchAttempts)
        .where(lt(feedFetchAttempts.finishedAt, thirtyDaysAgo))
        .returning({ id: feedFetchAttempts.id })
      const deletedJobs = await transaction
        .delete(processingJobs)
        .where(
          and(
            inArray(processingJobs.status, ["failed", "succeeded", "superseded"]),
            lt(processingJobs.finishedAt, oneHundredEightyDaysAgo),
          ),
        )
        .returning({ id: processingJobs.id })
      return {
        diagnosticPayloadsCleared: diagnosticPayloadsCleared.length,
        entryEvaluationsDeleted: deletedEvaluations.rows.length,
        feedFetchAttemptsDeleted: deletedFeedAttempts.length,
        processingAttemptsDeleted: deletedAttempts.length,
        processingJobsDeleted: deletedJobs.length,
        syncActionsDeleted: await deleteExpiredSyncActions(transaction, now),
      }
    })
  }

  async cleanupSyncActions(now: Date): Promise<number> {
    return this.database.transaction((transaction) => deleteExpiredSyncActions(transaction, now))
  }

  async getUnreadCounts(userId: string, view?: number): Promise<Record<string, number>> {
    return unreadCounts(this.database, userId, view)
  }

  async getUnreadSnapshot(userId: string, view?: number): Promise<UnreadSnapshot> {
    return this.database.transaction(
      async (transaction) => ({
        counts: await unreadCounts(transaction, userId, view),
        lastSyncId: await syncState(transaction, userId),
      }),
      { accessMode: "read only", isolationLevel: "repeatable read" },
    )
  }

  async getSyncState(userId: string): Promise<number> {
    return syncState(this.database, userId)
  }

  async listSyncActions(userId: string, afterId: number, limit: number): Promise<SyncDelta> {
    return this.database.transaction(
      async (transaction) => {
        const lastSyncId = await syncState(transaction, userId)
        const [floor] = await transaction
          .select({ floorId: syncFloors.floorId })
          .from(syncFloors)
          .where(eq(syncFloors.userId, userId))
        // A cursor below the floor missed deleted rows; one above everything logged comes from
        // another database (a restored or rebuilt instance). Both need a fresh snapshot.
        if (afterId < (floor?.floorId ?? 0) || afterId > lastSyncId) {
          return { actions: [], lastSyncId, hasMore: false, reset: true }
        }
        const rows = await transaction
          .select()
          .from(syncActions)
          .where(and(eq(syncActions.userId, userId), gt(syncActions.id, afterId)))
          .orderBy(asc(syncActions.id))
          .limit(limit + 1)
        const hasMore = rows.length > limit
        const actions = rows.slice(0, limit).map((row) => ({
          id: row.id,
          userId: row.userId,
          model: row.model as SyncModel,
          modelId: row.modelId,
          action: row.action as SyncActionType,
          data: row.data,
          createdAt: row.createdAt,
        }))
        return {
          actions,
          lastSyncId: hasMore ? actions.at(-1)!.id : lastSyncId,
          hasMore,
          reset: false,
        }
      },
      { accessMode: "read only", isolationLevel: "repeatable read" },
    )
  }

  async setEntriesRead(userId: string, entryIds: string[], read: boolean): Promise<void> {
    if (entryIds.length === 0) return
    await this.database.transaction(async (transaction) => {
      const flipped = await flipReadStates(transaction, userId, entryIds, read)
      await appendSyncActions(transaction, timelineReadFlipped(userId, read, flipped))
    })
  }

  async markAllAsRead(userId: string, filter: MarkAllReadFilter): Promise<Record<string, number>> {
    const conditions = [eq(subscriptions.userId, userId), isNull(readStates.readAt)]
    if (filter.view !== undefined) conditions.push(eq(subscriptions.view, filter.view))
    if (filter.feedId !== undefined) conditions.push(eq(subscriptions.feedId, filter.feedId))
    if (filter.feedIdList !== undefined && filter.feedIdList.length > 0) {
      conditions.push(inArray(subscriptions.feedId, filter.feedIdList))
    }
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ entryId: entries.id })
        .from(entries)
        .innerJoin(subscriptions, eq(subscriptions.feedId, entries.feedId))
        .leftJoin(
          readStates,
          and(eq(readStates.entryId, entries.id), eq(readStates.userId, userId)),
        )
        .where(and(...conditions))
      if (rows.length === 0) return {}
      const flipped = await flipReadStates(
        transaction,
        userId,
        rows.map((row) => row.entryId),
        true,
      )
      await appendSyncActions(transaction, timelineReadFlipped(userId, true, flipped))
      return flipped.reduce<Record<string, number>>((counts, row) => {
        counts[row.feedId] = (counts[row.feedId] ?? 0) + 1
        return counts
      }, {})
    })
  }

  async isEntryCollected(userId: string, entryId: string): Promise<boolean> {
    const [collection] = await this.database
      .select({ entryId: collections.entryId })
      .from(collections)
      .where(and(eq(collections.userId, userId), eq(collections.entryId, entryId)))
      .limit(1)
    return collection !== undefined
  }

  async setEntryCollected(userId: string, entryId: string, collected: boolean): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [entry] = await transaction
        .select({ feedId: entries.feedId, view: subscriptions.view })
        .from(entries)
        .innerJoin(
          subscriptions,
          and(eq(subscriptions.feedId, entries.feedId), eq(subscriptions.userId, userId)),
        )
        .where(eq(entries.id, entryId))
        .limit(1)
      if (!entry) return
      if (collected) {
        const [inserted] = await transaction
          .insert(collections)
          .values({ userId, entryId, createdAt: new Date() })
          .onConflictDoNothing()
          .returning({ createdAt: collections.createdAt })
        if (inserted) {
          await appendSyncActions(transaction, [
            collectionInserted(userId, { entryId, ...entry, createdAt: inserted.createdAt }),
          ])
        }
        return
      }
      const deleted = await transaction
        .delete(collections)
        .where(and(eq(collections.userId, userId), eq(collections.entryId, entryId)))
        .returning({ entryId: collections.entryId })
      if (deleted.length > 0) {
        await appendSyncActions(transaction, [collectionDeleted(userId, entryId)])
      }
    })
  }

  async listSubscribedFeeds(): Promise<FeedRecord[]> {
    const rows = await this.database
      .selectDistinct({ feed: feeds })
      .from(feeds)
      .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
    return rows.map((row) => row.feed)
  }

  async listFeedFetchAttempts(feedId: string, limit: number): Promise<FeedFetchAttemptRecord[]> {
    return (await this.database
      .select()
      .from(feedFetchAttempts)
      .where(eq(feedFetchAttempts.feedId, feedId))
      .orderBy(desc(feedFetchAttempts.finishedAt))
      .limit(Math.min(Math.max(limit, 1), 100))) as FeedFetchAttemptRecord[]
  }

  async checkHealth(): Promise<void> {
    await this.database.execute(sql`select 1`)
  }

  async getOperationalStats(now: Date): Promise<OperationalStats> {
    const [feedStats] = await this.database
      .select({
        feedAcquisitionFailures:
          sql<number>`count(distinct ${feeds.id}) filter (where ${feeds.consecutiveFailures} > 0)`.mapWith(
            Number,
          ),
        feedsDue:
          sql<number>`count(distinct ${feeds.id}) filter (where ${feeds.nextFetchAt} <= ${now})`.mapWith(
            Number,
          ),
        subscribedFeeds: sql<number>`count(distinct ${feeds.id})`.mapWith(Number),
      })
      .from(feeds)
      .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
    const processingJobsByStatus = await this.database
      .select({
        count: sql<number>`count(*)`.mapWith(Number),
        status: processingJobs.status,
      })
      .from(processingJobs)
      .groupBy(processingJobs.status)
    const jobs: OperationalStats["processingJobs"] = {
      failed: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      superseded: 0,
    }
    for (const row of processingJobsByStatus) {
      if (row.status in jobs) jobs[row.status as keyof typeof jobs] = row.count
    }
    return {
      feedAcquisitionFailures: feedStats?.feedAcquisitionFailures ?? 0,
      feedsDue: feedStats?.feedsDue ?? 0,
      processingJobs: jobs,
      subscribedFeeds: feedStats?.subscribedFeeds ?? 0,
    }
  }

  async getSettings(userId: string): Promise<Partial<Record<SettingsTab, SettingsRecord>>> {
    const rows = await this.database.select().from(settings).where(eq(settings.userId, userId))
    return Object.fromEntries(
      rows.map((row) => [row.tab, { payload: row.payload, updatedAt: row.updatedAt }]),
    ) as Partial<Record<SettingsTab, SettingsRecord>>
  }

  async setSettings(
    userId: string,
    tab: SettingsTab,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const updatedAt = new Date()
    await this.database.transaction(async (transaction) => {
      await transaction
        .insert(settings)
        .values({ userId, tab, payload, updatedAt })
        .onConflictDoUpdate({
          target: [settings.userId, settings.tab],
          set: { payload, updatedAt },
        })
      await appendSyncActions(transaction, [settingsUpdated(userId, tab, payload, updatedAt)])
    })
  }
}
