import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm"

import type { ApplicationDatabase } from "../db/database"
import { collections, entries, feeds, readStates, settings, subscriptions } from "../db/schema"
import type {
  DataStore,
  EntryListFilter,
  EntryRecord,
  FeedRecord,
  MarkAllReadFilter,
  SettingsRecord,
  SettingsTab,
  SubscriptionPatch,
  SubscriptionRecord,
} from "./types"

export class PostgresDataStore implements DataStore {
  constructor(private readonly database: ApplicationDatabase) {}

  async saveFeed(feed: FeedRecord, entryRecords: EntryRecord[]): Promise<void> {
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
          },
        })

      if (entryRecords.length === 0) return
      await transaction
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
            publishedAt: sql`excluded.published_at`,
          },
        })
    })
  }

  async createSubscription(subscription: SubscriptionRecord): Promise<void> {
    await this.database
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
  }

  async updateSubscription(
    userId: string,
    feedId: string,
    patch: SubscriptionPatch,
  ): Promise<SubscriptionRecord | null> {
    const [updated] = await this.database
      .update(subscriptions)
      .set(patch)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
      .returning()
    return updated ?? null
  }

  async deleteSubscriptions(userId: string, feedIds: string[]): Promise<void> {
    if (feedIds.length === 0) return
    await this.database
      .delete(subscriptions)
      .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.feedId, feedIds)))
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
    const conditions = [eq(subscriptions.userId, userId)]
    if (view !== undefined) conditions.push(eq(subscriptions.view, view))
    if (feedId !== undefined) conditions.push(eq(subscriptions.feedId, feedId))
    if (feedIdList !== undefined && feedIdList.length > 0) {
      conditions.push(inArray(subscriptions.feedId, feedIdList))
    }
    if (read === true) conditions.push(isNotNull(readStates.readAt))
    if (read === false) conditions.push(isNull(readStates.readAt))
    if (isCollection === true) conditions.push(isNotNull(collections.createdAt))
    if (publishedAfter !== undefined) conditions.push(gt(entries.publishedAt, publishedAfter))
    if (publishedBefore !== undefined) conditions.push(lt(entries.publishedAt, publishedBefore))

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
      .orderBy(desc(entries.publishedAt))
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

  async getUnreadCounts(userId: string, view?: number): Promise<Record<string, number>> {
    const userSubscriptions = await this.listSubscriptions(userId, view)
    const result: Record<string, number> = Object.fromEntries(
      userSubscriptions.map((subscription) => [subscription.feedId, 0]),
    )
    if (userSubscriptions.length === 0) return result

    const rows = await this.database
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

  async setEntriesRead(userId: string, entryIds: string[], read: boolean): Promise<void> {
    if (entryIds.length === 0) return
    const allowed = await this.database
      .select({ id: entries.id })
      .from(entries)
      .innerJoin(
        subscriptions,
        and(eq(subscriptions.feedId, entries.feedId), eq(subscriptions.userId, userId)),
      )
      .where(inArray(entries.id, entryIds))
    const allowedIds = allowed.map((row) => row.id)
    if (allowedIds.length === 0) return

    if (read) {
      const readAt = new Date()
      await this.database
        .insert(readStates)
        .values(allowedIds.map((entryId) => ({ userId, entryId, readAt })))
        .onConflictDoUpdate({
          target: [readStates.userId, readStates.entryId],
          set: { readAt },
        })
    } else {
      await this.database
        .delete(readStates)
        .where(and(eq(readStates.userId, userId), inArray(readStates.entryId, allowedIds)))
    }
  }

  async markAllAsRead(userId: string, filter: MarkAllReadFilter): Promise<Record<string, number>> {
    const conditions = [eq(subscriptions.userId, userId), isNull(readStates.readAt)]
    if (filter.view !== undefined) conditions.push(eq(subscriptions.view, filter.view))
    if (filter.feedId !== undefined) conditions.push(eq(subscriptions.feedId, filter.feedId))
    if (filter.feedIdList !== undefined && filter.feedIdList.length > 0) {
      conditions.push(inArray(subscriptions.feedId, filter.feedIdList))
    }
    const rows = await this.database
      .select({ entryId: entries.id, feedId: entries.feedId })
      .from(entries)
      .innerJoin(subscriptions, eq(subscriptions.feedId, entries.feedId))
      .leftJoin(readStates, and(eq(readStates.entryId, entries.id), eq(readStates.userId, userId)))
      .where(and(...conditions))

    if (rows.length > 0)
      await this.setEntriesRead(
        userId,
        rows.map((row) => row.entryId),
        true,
      )
    return rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.feedId] = (counts[row.feedId] ?? 0) + 1
      return counts
    }, {})
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
    if (!(await this.getEntry(userId, entryId))) return
    if (collected) {
      await this.database
        .insert(collections)
        .values({ userId, entryId, createdAt: new Date() })
        .onConflictDoNothing()
    } else {
      await this.database
        .delete(collections)
        .where(and(eq(collections.userId, userId), eq(collections.entryId, entryId)))
    }
  }

  async listSubscribedFeeds(): Promise<FeedRecord[]> {
    const rows = await this.database
      .selectDistinct({ feed: feeds })
      .from(feeds)
      .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
    return rows.map((row) => row.feed)
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
    await this.database
      .insert(settings)
      .values({ userId, tab, payload, updatedAt })
      .onConflictDoUpdate({
        target: [settings.userId, settings.tab],
        set: { payload, updatedAt },
      })
  }
}
